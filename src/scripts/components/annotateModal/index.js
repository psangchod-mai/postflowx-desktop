// Shared Annotate Modal (PostFlowX)
// - Single source of truth for Markers + Reviews
// - Vector-object model (editable/movable) rendered to canvas
// - Spot-On style Note Type (Add/Remove/Change) + Scope of Work

export function openAnnotateModal(opts = {}){
  if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('annotate')) {
    window.PFX_GUARD?.deny?.('annotate');
    return null;
  }
  const {
    srcDataUrl,
    srcVideoUrl = '',
    videoCurrentTime = null,
    videoAutoPlay = false,
    videoFps = 24,
    videoClipStartTime = null,
    videoClipEndTime = null,
    videoCurrentFrame = null,
    videoClipStartFrame = null,
    videoClipEndFrame = null,
    title = '',
    initialTool = 'pen',
    nativeResolution = false,
    // taxonomy
    noteTypeGroup = '',
    noteType = '',
    scopeOfWork = '',
    initialShapes = null,
    // Original logical canvas size when shapes were created — used to rescale shapes to the
    // current stage size on first fit(), preventing proportion drift between modal opens.
    initialLogicalW = 0,
    initialLogicalH = 0,
    // marker/review note text (editable inside annotate)
    noteText = '',
    // optional DOM container — defaults to documentElement; pass fullscreen element to keep
    // the modal visible when the host element is in fullscreen mode.
    container = null,
    // When true (and container is set), the modal fills the container edge-to-edge with no
    // border-radius / box-shadow — used for the fullscreen in-player annotation experience.
    docked = false,
    // callbacks
    onMetaChange = null,
    onDone = null,
    onCancel = null,
  } = opts || {};

  if (!srcDataUrl && !srcVideoUrl) return;

  const TT = (s)=>{
    try{ if (typeof window.PFX_t === 'function') return window.PFX_t(String(s||'')); }catch{}
    return String(s||'');
  };

  const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const titleText = escapeHtml(title);


  const iconSvg = (name)=>{
    switch(String(name||'')){
      case 'close': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>`;
      case 'move': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4l7 16 2-6 6-2L5 4z"/><path d="M14 14l5 5"/></svg>`;
      case 'pen': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1.2L18 9.3l-3.3-3.3L5.2 15.5 4 20z"/><path d="M13.8 6.9l3.3 3.3"/></svg>`;
      case 'highlighter': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4l7 7"/><path d="M6 18l7-7 5 5-7 4H6v-2z"/><path d="M14 6l4 4"/></svg>`;
      case 'arrow': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5"/><path d="M11 5h8v8"/></svg>`;
      case 'rect': return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="10" rx="2"/></svg>`;
      case 'circle': return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>`;
      case 'text': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14"/><path d="M12 6v12"/><path d="M8 18h8"/></svg>`;
      case 'eraser': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7l8 8"/><path d="M6 20h8l6-6-8-8-8 8 4 6z"/></svg>`;
      case 'width': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14"/><path d="M7 12h10"/><path d="M9 16h6"/></svg>`;
      case 'opacity': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4c4 5 6 8 6 11a6 6 0 1 1-12 0c0-3 2-6 6-11z"/><path d="M12 4v17"/></svg>`;
      case 'undo': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8L5 12l4 4"/><path d="M5 12h9a5 5 0 1 1 0 10h-2"/></svg>`;
      case 'redo': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 8l4 4-4 4"/><path d="M19 12h-9a5 5 0 1 0 0 10h2"/></svg>`;
      case 'clear': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`;
      case 'gear': return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6z"/><path d="M19.4 13.5a7.9 7.9 0 0 0 .1-3l2-1.2-2-3.4-2.3.7a8.8 8.8 0 0 0-2.5-1.4l-.5-2.4h-4.4l-.5 2.4a8.8 8.8 0 0 0-2.5 1.4l-2.3-.7-2 3.4 2 1.2a7.9 7.9 0 0 0 .1 3l-2 1.2 2 3.4 2.3-.7a8.8 8.8 0 0 0 2.5 1.4l.5 2.4h4.4l.5-2.4a8.8 8.8 0 0 0 2.5-1.4l2.3.7 2-3.4-2-1.2z"/></svg>`;
      case 'face':    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="4.5"/><circle cx="10" cy="7.8" r=".6" fill="currentColor" stroke="none"/><circle cx="14" cy="7.8" r=".6" fill="currentColor" stroke="none"/><path d="M10 10.2s.8 1 2 1 2-1 2-1"/><path d="M7 15c-2.5 1-4 3-4 5h18c0-2-1.5-4-4-5"/></svg>`;
      case 'screen':  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>`;
      case 'aitext':  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h16M4 10h12M4 14h8"/><rect x="14" y="12" width="7" height="7" rx="1.5" stroke-width="1.2"/><path d="M16 16h3M17.5 14.5v3" stroke-width="1.2"/></svg>`;
      case 'suggest': return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 4.9 12l-.9 3H8l-.9-3A7 7 0 0 1 12 2z"/><path d="M9.5 21h5"/><path d="M12 7v4M10 9h4" stroke-width="1.2"/></svg>`;
      default: return '';
    }
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'mps-modal-backdrop';
  backdrop.style.setProperty('background', 'rgba(2,4,10,0.92)', 'important');
  backdrop.style.setProperty('backdrop-filter', 'blur(4px)', 'important');
  backdrop.style.setProperty('-webkit-backdrop-filter', 'blur(4px)', 'important');
  backdrop.style.setProperty('z-index', '2147483640', 'important');

  const modal = document.createElement('div');
  modal.className = 'mps-modal sm-anno-modal';
  modal.style.setProperty('background',
    'linear-gradient(rgba(6,8,18,0.97),rgba(6,8,18,0.97)) padding-box,' +
    'linear-gradient(90deg,rgba(84,213,255,0.50),rgba(176,108,255,0.42),rgba(84,213,255,0.50)) border-box',
    'important');
  modal.style.setProperty('background-size', '100% 100%, 200% 100%', 'important');
  modal.style.setProperty('border', '1px solid transparent', 'important');
  modal.style.setProperty('backdrop-filter', 'blur(24px) saturate(180%)', 'important');
  modal.style.setProperty('-webkit-backdrop-filter', 'blur(24px) saturate(180%)', 'important');
  backdrop.appendChild(modal);

  const head = document.createElement('div');
  head.className = 'mps-modal-head sm-anno-head';

  // Note Types config
  const ntCfg = (typeof window.PFX_getNoteTypesConfig === 'function') ? window.PFX_getNoteTypesConfig() : { add:[], remove:[], change:[] };
  const curNt = (String(noteTypeGroup||'').trim() && String(noteType||'').trim()) ? `${String(noteTypeGroup).toLowerCase()}|${String(noteType)}` : '';

  const buildNtGroup = (key, label) => {
    const arr = Array.isArray(ntCfg?.[key]) ? ntCfg[key] : [];
    const optsHtml = arr.map(v => {
      const val = `${key}|${v}`;
      const sel = (val === curNt) ? ' selected' : '';
      // display localized, keep value canonical
      return `<option value="${escapeHtml(val)}"${sel}>${escapeHtml(TT(v))}</option>`;
    }).join('');
    return `<optgroup label="${escapeHtml(TT(label))}">${optsHtml}</optgroup>`;
  };

  const ntSelHtml = `
    <select class="sm-anno-nt" aria-label="${escapeHtml(TT('Note Type'))}">
      <option value=""${curNt===''?' selected':''}>— ${escapeHtml(TT('Note Type'))} —</option>
      ${buildNtGroup('add','Add')}
      ${buildNtGroup('remove','Remove')}
      ${buildNtGroup('change','Change')}
    </select>
  `;

  const TRACK_CFG_KEY = 'pfx_annotate_track_cfg_v1';
  const TRACK_CFG_DEFAULT = {
    mode: 'auto',
    scope: 'all',
    remoteUrl: '',
    remoteKey: '',
    githubManifestUrl: '',
    apiCatalogUrl: '',
  };
  const _loadTrackCfg = ()=>{
    try{
      const raw = localStorage.getItem(TRACK_CFG_KEY);
      if (!raw) return { ...TRACK_CFG_DEFAULT };
      const parsed = JSON.parse(raw);
      return { ...TRACK_CFG_DEFAULT, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    }catch{}
    return { ...TRACK_CFG_DEFAULT };
  };
  let trackCfg = _loadTrackCfg();
  const trackModeHtml = `
    <select class="sm-anno-trackMode" aria-label="${escapeHtml(TT('Tracking Engine'))}">
      <option value="auto"${trackCfg.mode === 'auto' ? ' selected' : ''}>${escapeHtml(TT('Auto'))}</option>
      <option value="local"${trackCfg.mode === 'local' ? ' selected' : ''}>${escapeHtml(TT('Local'))}</option>
      <option value="detect"${trackCfg.mode === 'detect' ? ' selected' : ''}>${escapeHtml(TT('Detect Assist'))}</option>
      <option value="remote"${trackCfg.mode === 'remote' ? ' selected' : ''}>${escapeHtml(TT('Remote API'))}</option>
    </select>
  `;
  const trackScopeHtml = `
    <select class="sm-anno-trackScope" aria-label="${escapeHtml(TT('Tracking Source Search'))}">
      <option value="all"${trackCfg.scope === 'all' ? ' selected' : ''}>${escapeHtml(TT('All Sources'))}</option>
      <option value="local"${trackCfg.scope === 'local' ? ' selected' : ''}>${escapeHtml(TT('Local Only'))}</option>
      <option value="remote"${trackCfg.scope === 'remote' ? ' selected' : ''}>${escapeHtml(TT('Remote Only'))}</option>
      <option value="catalog"${trackCfg.scope === 'catalog' ? ' selected' : ''}>${escapeHtml(TT('GitHub / API Catalog'))}</option>
    </select>
  `;


  head.innerHTML = `
    <div class="sm-anno-headstack">
    <div class="sm-anno-toolbar">
      <div class="sm-anno-toolbar-left">
        <button class="sm-anno-iconbtn sm-anno-close" data-act="close" title="${escapeHtml(TT('Close'))} (Esc)" aria-label="${escapeHtml(TT('Close'))}">
          ${iconSvg('close')}
        </button>
        <div class="sm-anno-label"><span class="sm-anno-label-spark" aria-hidden="true">◈</span> ${escapeHtml(TT('Annotate'))} <span class="muted">${titleText}</span></div>
      </div>

      <div class="sm-anno-toolbar-center">
        <div class="sm-anno-group" role="group" aria-label="${escapeHtml(TT('Tools'))}">
          <button class="sm-anno-iconbtn" data-tool="move" title="${escapeHtml(TT('Select / Move'))} (V)"><span class="bar"></span>
            ${iconSvg('move')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="pen" title="${escapeHtml(TT('Pen'))} (P)"><span class="bar"></span>
            ${iconSvg('pen')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="highlighter" title="${escapeHtml(TT('Highlighter'))} (H)"><span class="bar"></span>
            ${iconSvg('highlighter')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="arrow" title="${escapeHtml(TT('Arrow'))} (A)"><span class="bar"></span>
            ${iconSvg('arrow')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="rect" title="${escapeHtml(TT('Rectangle'))} (R)"><span class="bar"></span>
            ${iconSvg('rect')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="circle" title="${escapeHtml(TT('Circle'))} (O)"><span class="bar"></span>
            ${iconSvg('circle')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="text" title="${escapeHtml(TT('Text'))} (T)"><span class="bar"></span>
            ${iconSvg('text')}
          </button>
          <button class="sm-anno-iconbtn" data-tool="eraser" title="${escapeHtml(TT('Eraser'))} (E)"><span class="bar"></span>
            ${iconSvg('eraser')}
          </button>
        </div>

        <span class="sm-anno-divider" aria-hidden="true"></span>

        <div class="sm-anno-group sm-anno-style-group" role="group" aria-label="${escapeHtml(TT('Style'))}">
          <div class="sm-anno-colorWrap">
            <button class="sm-anno-colorbtn" data-act="toggleColor" title="${escapeHtml(TT('Color &amp; Opacity'))}" aria-haspopup="true">
              <span class="sm-anno-colordisc" style="background:#ff4c4c" aria-hidden="true"></span>
              <svg class="sm-anno-chevron" viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div class="sm-anno-colorpanel" hidden>
              <div class="sm-anno-swatchrow">
                <button class="sm-anno-swatch is-active" data-color="#ff4c4c" title="${escapeHtml(TT('Red'))}" style="--swatch:#ff4c4c"></button>
                <button class="sm-anno-swatch" data-color="#ffd166" title="${escapeHtml(TT('Yellow'))}" style="--swatch:#ffd166"></button>
                <button class="sm-anno-swatch" data-color="#2ecc71" title="${escapeHtml(TT('Green'))}" style="--swatch:#2ecc71"></button>
                <button class="sm-anno-swatch" data-color="#2ed8ff" title="${escapeHtml(TT('Cyan'))}" style="--swatch:#2ed8ff"></button>
                <button class="sm-anno-swatch" data-color="#3a86ff" title="${escapeHtml(TT('Blue'))}" style="--swatch:#3a86ff"></button>
                <button class="sm-anno-swatch" data-color="#b06cff" title="${escapeHtml(TT('Purple'))}" style="--swatch:#b06cff"></button>
                <input class="sm-anno-colorpick" type="color" value="#ff4c4c" title="${escapeHtml(TT('Custom color'))}" aria-label="${escapeHtml(TT('Custom color'))}">
              </div>
              <div class="sm-anno-oprow">
                <span class="sm-anno-oplabel">${escapeHtml(TT('Opacity'))}</span>
                <input class="sm-anno-opacity" type="range" min="0.10" max="1.00" step="0.05" value="1.00" aria-label="${escapeHtml(TT('Opacity'))}">
                <span class="sm-anno-opval">100%</span>
              </div>
            </div>
          </div>
          <span class="sm-anno-sub-div" aria-hidden="true"></span>
          <div class="sm-anno-strokeWrap">
            <button class="sm-anno-strokebtn" data-act="toggleStroke" title="${escapeHtml(TT('Stroke Width'))}" aria-haspopup="true">
              <svg class="sm-anno-strokepreview" viewBox="0 0 24 10" aria-hidden="true">
                <line x1="2" y1="5" x2="22" y2="5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
              </svg>
              <svg class="sm-anno-chevron" viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div class="sm-anno-strokepanel" hidden>
              <button class="sm-anno-wopt" data-w="2" title="${escapeHtml(TT('Thin'))}"><svg viewBox="0 0 64 18"><line x1="4" y1="9" x2="60" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
              <button class="sm-anno-wopt is-active-w" data-w="4" title="${escapeHtml(TT('Medium'))}"><svg viewBox="0 0 64 18"><line x1="4" y1="9" x2="60" y2="9" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg></button>
              <button class="sm-anno-wopt" data-w="7" title="${escapeHtml(TT('Thick'))}"><svg viewBox="0 0 64 18"><line x1="4" y1="9" x2="60" y2="9" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg></button>
              <button class="sm-anno-wopt" data-w="11" title="${escapeHtml(TT('Extra Thick'))}"><svg viewBox="0 0 64 18"><line x1="4" y1="9" x2="60" y2="9" stroke="currentColor" stroke-width="10" stroke-linecap="round"/></svg></button>
            </div>
          </div>
          </div>

        <span class="sm-anno-divider" aria-hidden="true"></span>

        <div class="sm-anno-group" role="group" aria-label="${escapeHtml(TT('Actions'))}">
          <button class="sm-anno-iconbtn" data-act="undo" title="${escapeHtml(TT('Undo'))} (⌘/Ctrl+Z)">
            ${iconSvg('undo')}
          </button>
          <button class="sm-anno-iconbtn" data-act="redo" title="${escapeHtml(TT('Redo'))} (⌘/Ctrl+Shift+Z / Ctrl+Y)">
            ${iconSvg('redo')}
          </button>
          <button class="sm-anno-iconbtn" data-act="clear" title="${escapeHtml(TT('Clear'))}">
            ${iconSvg('clear')}
          </button>
        </div>


      </div>

      <div class="sm-anno-toolbar-right">
        <div class="sm-anno-shape-count" title="${escapeHtml(TT('Annotations on this frame'))}"><span class="sm-anno-shape-num">0</span><span class="sm-anno-shape-k"> ann</span></div>
        <div class="sm-anno-ai-status" data-state="ready" aria-live="polite">READY</div>
        <button class="btn mini sm-anno-cancel" data-act="cancel" title="${escapeHtml(TT('Cancel'))} (Esc)">${escapeHtml(TT('Cancel'))}</button>
        <button class="btn mini theme-q2 sm-anno-done" data-act="done" title="${escapeHtml(TT('Save'))} + ${escapeHtml(TT('Close'))}">${escapeHtml(TT('Done'))}</button>
      </div>
    </div>

    <div class="sm-anno-meta">
      <div class="sm-anno-field">
        <span class="sm-anno-k">${escapeHtml(TT('Type'))}</span>
        ${ntSelHtml}
        <button class="sm-anno-iconbtn sm-anno-gear" data-act="ntEdit" title="${escapeHtml(TT('Edit Note Types'))}">
          ${iconSvg('gear')}
        </button>
      </div>
      <div class="sm-anno-field sm-anno-trackModeField">
        <span class="sm-anno-k">${escapeHtml(TT('Engine'))}</span>
        ${trackModeHtml}
        <button class="sm-anno-trackSourcesBtn" data-act="toggleTrackSources" title="${escapeHtml(TT('Tracking Sources'))}">
          ${escapeHtml(TT('Sources'))}
        </button>
      </div>
      <div class="sm-anno-field sm-anno-metaTrack" role="group" aria-label="${escapeHtml(TT('Tracking'))}">
        <span class="sm-anno-k">${escapeHtml(TT('Tracking'))}</span>
        <button class="sm-anno-iconbtn sm-anno-track-btn" data-act="track" title="${escapeHtml(TT('Auto-track selected annotation across frames'))}" disabled>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="5"/><circle cx="7" cy="7" r="2"/><line x1="7" y1="1" x2="7" y2="3"/><line x1="7" y1="11" x2="7" y2="13"/><line x1="1" y1="7" x2="3" y2="7"/><line x1="11" y1="7" x2="13" y2="7"/></svg>
          Track
        </button>
        <button class="sm-anno-iconbtn sm-anno-track-btn sm-anno-trackall-btn" data-act="trackAll" title="${escapeHtml(TT('Track All — auto-track every annotation shape'))}" disabled>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="7" r="2.5"/><circle cx="10" cy="7" r="2.5"/><line x1="4" y1="1" x2="4" y2="3"/><line x1="4" y1="11" x2="4" y2="13"/><line x1="10" y1="1" x2="10" y2="3"/><line x1="10" y1="11" x2="10" y2="13"/></svg>
          Track All
        </button>
        <button class="sm-anno-iconbtn sm-anno-track-btn sm-anno-detecttrack-btn" data-act="detectAndTrack" title="${escapeHtml(TT('Detect subjects (faces, screens, text) then auto-track all'))}" disabled>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><circle cx="10.5" cy="10.5" r="2"/><line x1="10.5" y1="1" x2="10.5" y2="3" opacity=".5"/></svg>
          Detect &amp; Track
        </button>
      </div>
    </div>
    <div class="sm-anno-trackSourcePanel" hidden>
      <div class="sm-anno-trackSourceGrid">
        <label class="sm-anno-trackSourceField">
          <span class="sm-anno-k">${escapeHtml(TT('Search'))}</span>
          ${trackScopeHtml}
        </label>
        <label class="sm-anno-trackSourceField sm-anno-trackSourceField-wide">
          <span class="sm-anno-k">${escapeHtml(TT('Remote API URL'))}</span>
          <input class="sm-anno-trackRemoteUrl" type="url" value="${escapeHtml(trackCfg.remoteUrl)}" placeholder="https://example.com/api/track">
        </label>
        <label class="sm-anno-trackSourceField">
          <span class="sm-anno-k">${escapeHtml(TT('API Key'))}</span>
          <input class="sm-anno-trackRemoteKey" type="password" value="${escapeHtml(trackCfg.remoteKey)}" placeholder="${escapeHtml(TT('Optional'))}">
        </label>
        <label class="sm-anno-trackSourceField sm-anno-trackSourceField-wide">
          <span class="sm-anno-k">${escapeHtml(TT('GitHub Manifest URL'))}</span>
          <input class="sm-anno-trackGithubUrl" type="url" value="${escapeHtml(trackCfg.githubManifestUrl)}" placeholder="https://raw.githubusercontent.com/.../tracking-providers.json">
        </label>
        <label class="sm-anno-trackSourceField sm-anno-trackSourceField-wide">
          <span class="sm-anno-k">${escapeHtml(TT('API Catalog URL'))}</span>
          <input class="sm-anno-trackCatalogUrl" type="url" value="${escapeHtml(trackCfg.apiCatalogUrl)}" placeholder="https://example.com/tracking/catalog.json">
        </label>
      </div>
      <div class="sm-anno-trackSourceHint">${escapeHtml(TT('Auto can search local tracking, remote APIs, and GitHub/API provider manifests. Remote endpoints must allow CORS.'))}</div>
    </div>
    </div>
  `;
  modal.appendChild(head);

  const hasVideoSource = !!srcVideoUrl;
  // When a video is available we still inject the captured thumbnail as a frame-lock overlay.
  // H.264/HEVC GOP-based seeking means video.currentTime seeks to the nearest keyframe, so
  // the first decoded frame after seek can be 1-5 frames off from the requested timecode.
  // The thumbnail was captured directly from the playing Pull Prep video, so it IS the correct
  // frame. We pin it on top until the user manually seeks/plays (which unlocks live video).
  const hasThumbnailOverlay = hasVideoSource && !!srcDataUrl;
  const mediaHtml = hasVideoSource
    ? `<video class="sm-anno-img sm-anno-video" src="${escapeHtml(srcVideoUrl)}" playsinline muted preload="auto"></video>`
      + (hasThumbnailOverlay ? `<img class="sm-anno-frame-lock" src="${escapeHtml(srcDataUrl)}" alt="" aria-hidden="true">` : '')
    : `<img class="sm-anno-img" src="${srcDataUrl}" alt="">`;
  const _IC = {
    // |◀  bar-left + left-pointing triangle = go to start
    jumpStart: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1.8" y="3" width="2.2" height="10" rx="1.1"/><polygon points="13,3 5,8 13,13"/></svg>`,
    // ◀◀  double left-pointing triangles = step back
    stepBack:  `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><polygon points="9,3 2,8 9,13"/><polygon points="15,3 8,8 15,13"/></svg>`,
    // ▶  single right triangle = play
    play:      `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><polygon points="3,2 14,8 3,14"/></svg>`,
    // ❚❚  two vertical bars = pause
    pause:     `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2" width="4" height="12" rx="1.2"/><rect x="9.5" y="2" width="4" height="12" rx="1.2"/></svg>`,
    // ▶▶  double right-pointing triangles = step forward
    stepNext:  `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><polygon points="1,3 8,8 1,13"/><polygon points="7,3 14,8 7,13"/></svg>`,
    // ▶|  right-pointing triangle + bar-right = go to end
    jumpEnd:   `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><polygon points="1.5,3 10.5,8 1.5,13"/><rect x="12" y="3" width="2.2" height="10" rx="1.1"/></svg>`,
    // ↺  circular arrow with arrowhead = loop
    loop:      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.2-3.4"/><polyline points="12.3,1.8 12.3,4.8 9.3,4.8"/></svg>`,
  };
  const transportHtml = hasVideoSource ? `
    <div class="sm-anno-transport" aria-label="${escapeHtml(TT('Video Preview Controls'))}">
      <div class="sm-anno-tport-btns">
        <button class="sm-anno-transportBtn sm-anno-jumpStart" type="button" title="${escapeHtml(TT('Go to Start (Home)'))}" aria-label="${escapeHtml(TT('Go to Start'))}">${_IC.jumpStart}</button>
        <button class="sm-anno-transportBtn sm-anno-stepPrev" type="button" title="${escapeHtml(TT('Step Back · J · ← · Shift+← ×10'))}" aria-label="${escapeHtml(TT('Step Back'))}">${_IC.stepBack}</button>
        <button class="sm-anno-transportBtn sm-anno-playToggle" type="button" title="${escapeHtml(TT('Play / Pause · Space'))}" aria-label="${escapeHtml(TT('Play / Pause'))}">${_IC.play}</button>
        <button class="sm-anno-transportBtn sm-anno-stepNext" type="button" title="${escapeHtml(TT('Step Forward · L · → · Shift+→ ×10'))}" aria-label="${escapeHtml(TT('Step Forward'))}">${_IC.stepNext}</button>
        <button class="sm-anno-transportBtn sm-anno-jumpEnd" type="button" title="${escapeHtml(TT('Go to End (End)'))}" aria-label="${escapeHtml(TT('Go to End'))}">${_IC.jumpEnd}</button>
        <button class="sm-anno-transportBtn sm-anno-loopBtn" type="button" data-act="toggleLoop" title="${escapeHtml(TT('Loop playback (,)'))}" aria-label="${escapeHtml(TT('Loop'))}">${_IC.loop}</button>
      </div>
      <div class="sm-anno-tport-info">
        <span class="sm-anno-speed-badge" title="${escapeHtml(TT('Playback speed · J shuttle reverse · L shuttle forward · K stop'))}">1×</span>
        <span class="sm-anno-transportTime" title="${escapeHtml(TT('Current / Duration · Home End to jump'))}">00:00 / 00:00</span>
        <button class="sm-anno-transportBtn sm-anno-shortcutsBtn" type="button" data-act="toggleShortcuts" title="${escapeHtml(TT('Keyboard shortcuts (?)'))}"><span class="sm-anno-shortcuts-label">?</span></button>
      </div>
    </div>
  ` : '';

  const body = document.createElement('div');
  body.className = 'mps-modal-body';
  body.innerHTML = `
    <div class="sm-anno-stage${hasVideoSource ? ' is-video' : ''}">
      <!-- Smart context strip: live AI insights + scene stats, updates on selection -->
      <div class="sm-anno-ctx-strip" aria-live="polite" aria-atomic="false">
        <span class="sm-anno-ctx-pill sm-anno-ctx-scene">0 ann</span>
        <span class="sm-anno-ctx-divider" aria-hidden="true">·</span>
        <span class="sm-anno-ctx-pill sm-anno-ctx-ai-hint">✦ AI ready</span>
        <span class="sm-anno-ctx-divider" aria-hidden="true">·</span>
        <span class="sm-anno-ctx-pill sm-anno-ctx-sel" style="display:none"></span>
        <button class="sm-anno-ctx-brief" title="Generate VFX Brief — analyze all shapes and produce a shot summary (B)">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 2h10v10H2z"/><path d="M4 4.5h6M4 7h4M4 9.5h5"/></svg>
          Brief
        </button>
      </div>
      <div class="sm-anno-wrap">
        ${mediaHtml}
        <canvas class="sm-anno-canvas"></canvas>
      </div>
      <div class="sm-anno-ai-sidebar" role="group" aria-label="${escapeHtml(TT('AI Detect'))}">
        <div class="sm-anno-ai-sidebar-label">✦ AI</div>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn sm-anno-ai-scan-all" data-act="aiScanAll"
                title="Scan All (\`) — detect faces, text, screens, keys, mattes in one pass">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" opacity=".6"/></svg>
          <span class="sm-anno-ai-label">Scan All</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectFaces"
                title="${escapeHtml(TT('Detect Faces'))} (F)">
          ${iconSvg('face')}
          <span class="sm-anno-ai-label">Faces</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectScreens"
                title="${escapeHtml(TT('Detect Screens'))}">
          ${iconSvg('screen')}
          <span class="sm-anno-ai-label">Screens</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectText"
                title="${escapeHtml(TT('Detect Text'))}">
          ${iconSvg('aitext')}
          <span class="sm-anno-ai-label">Text</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectKeys"
                title="Detect Green/Blue Screen — find chroma-key areas">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 9h4M7 12h6M7 15h3" opacity=".5"/><circle cx="16" cy="12" r="3" stroke-width="1.2"/><path d="M14.5 12.5l1 1 2-2" stroke-width="1.2"/></svg>
          <span class="sm-anno-ai-label">Key</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectMatte"
                title="Detect Hard Matte — find letterbox / pillarbox bars">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="2"/><rect x="2" y="2" width="20" height="5" fill="currentColor" opacity=".35" stroke="none"/><rect x="2" y="17" width="20" height="5" fill="currentColor" opacity=".35" stroke="none" rx="2"/><rect x="2" y="7" width="20" height="10" stroke-width="1"/></svg>
          <span class="sm-anno-ai-label">Matte</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectWire"
                title="Detect Wire/Rig — find thin lines (wires, cables, rigs to remove)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/><line x1="3" y1="12" x2="21" y2="12" opacity=".4"/><circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none"/></svg>
          <span class="sm-anno-ai-label">Wire</span>
        </button>
        <div class="sm-anno-ai-divider" aria-hidden="true"></div>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn sm-anno-ai-sam-btn" data-act="aiSamMode"
                title="SAM Click (S) — click any object to auto-draw a precise annotation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 3C7 3 3 7 3 12s4 9 9 9 9-4 9-9"/><path d="M20 3l-3 3 3 3"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" opacity=".7"/><path d="M12 9v-2M12 15v2M9 12H7M15 12h2" stroke-width="1.2"/></svg>
          <span class="sm-anno-ai-label">SAM</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDetectML"
                title="ML Detect (D) — YOLOS neural net object detection">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>
          <span class="sm-anno-ai-label">Detect</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiDepthMap"
                title="Depth Map (Z) — show AI depth estimation overlay">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 6l9-3 9 3v12l-9 3-9-3V6z"/><path d="M12 3v18M3 6l9 3 9-3" opacity=".5"/></svg>
          <span class="sm-anno-ai-label">Depth</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiSmartSuggest"
                title="Smart Suggest (G) — analyze selected shape and suggest note type">
          ${iconSvg('suggest')}
          <span class="sm-anno-ai-label">Suggest</span>
        </button>
        <div class="sm-anno-ai-divider" aria-hidden="true"></div>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiFlowViz"
                title="Motion Vectors (W) — RAFT optical flow arrows per frame">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 12h14"/><path d="M15 7l5 5-5 5"/><path d="M3 7l4 4-4 4" opacity=".4"/></svg>
          <span class="sm-anno-ai-label">Flow</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiObjFlowViz"
                title="Object Flow — dense LK motion vectors inside tracked bounding boxes (no model needed)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 9l2 2M12 9l2 2M17 9l2 2M7 14l2 2M12 14l2 2M17 14l2 2" stroke-width="1.1" opacity=".8"/></svg>
          <span class="sm-anno-ai-label">Obj Flow</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiVelocityHud"
                title="Velocity HUD — live speed &amp; direction badge on every tracked shape">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3" stroke-width="1.4"/><path d="M7 3.5l1.5 2.2M17 3.5l-1.5 2.2" stroke-width="1" opacity=".5"/></svg>
          <span class="sm-anno-ai-label">Speed</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiSmoothPath"
                title="Smooth Path — apply Gaussian smoothing to selected shape's tracked keyframes">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 17c2-6 4-9 9-9s7 3 9 9" stroke-dasharray="2 0"/><path d="M3 17c1-3 3-5 5-5" stroke-dasharray="3 2" opacity=".5"/></svg>
          <span class="sm-anno-ai-label">Smooth</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn sm-anno-ai-3d-btn" data-act="aiPlanarTrack"
                title="Planar Track 3D — track a flat surface (screen/wall) through 3D space. Select a rect first. Downloads RAFT-Small ~6 MB on first use.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 8l10-5 10 5v8l-10 5-10-5V8z"/><path d="M12 3v18M2 8l10 5 10-5" opacity=".6"/><path d="M7 10.5l5 2.5 5-2.5" stroke-width="1" opacity=".4"/></svg>
          <span class="sm-anno-ai-label">3D Plane</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn sm-anno-ai-3d-btn" data-act="aiDepthTrack"
                title="3D Depth Track — show Z-depth and 3D velocity for tracked shapes. Downloads RAFT + Depth Anything (~35 MB total) on first use.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><path d="M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M15.6 8.4l2.8-2.8M5.6 18.4l2.8-2.8" stroke-width="1" opacity=".5"/></svg>
          <span class="sm-anno-ai-label">3D Depth</span>
        </button>
        <button class="sm-anno-iconbtn sm-anno-ai-btn sm-anno-ai-side-btn" data-act="aiEdgeSnap"
                title="Edge Snap — snap selected rect to nearest object edges">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5" y="5" width="14" height="14" rx="1" stroke-dasharray="3 2"/><path d="M9 9l6 6M15 9l-6 6"/><path d="M5 12h3M16 12h3M12 5v3M12 16v3" opacity=".5"/></svg>
          <span class="sm-anno-ai-label">Snap</span>
        </button>
      </div>
      ${transportHtml}
      ${hasVideoSource ? `<canvas class="sm-anno-tl-canvas" aria-label="Shape timeline"></canvas>` : ''}
      ${hasVideoSource ? `<div class="sm-anno-shortcuts-panel" aria-hidden="true">
        <div class="sm-anno-sc-title">Keyboard Shortcuts</div>
        <div class="sm-anno-sc-grid">
          <kbd>Space</kbd><span>Play / Pause</span>
          <kbd>J</kbd><span>Shuttle reverse — repeat to accelerate (1× → 2× → 4× → 8×)</span>
          <kbd>K</kbd><span>Stop / brake shuttle</span>
          <kbd>L</kbd><span>Shuttle forward — repeat to accelerate (1× → 2× → 4× → 8×)</span>
          <kbd>← →</kbd><span>Step 1 frame</span>
          <kbd>⇧← ⇧→</kbd><span>Step 10 frames</span>
          <kbd>Home  End</kbd><span>Jump to clip start / end</span>
          <kbd>I</kbd><span>Set selected shape In point to current frame</span>
          <kbd>O</kbd><span>Set selected shape Out point (or select Circle tool)</span>
          <kbd>,</kbd><span>Toggle loop playback</span>
          <kbd>⌘ Scroll</kbd><span>Zoom timeline in / out</span>
          <kbd>V P H A R T E</kbd><span>Tools: Move Pen Highlighter Arrow Rect Text Eraser</span>
          <kbd>1  2  3</kbd><span>Note type: Add / Remove / Change</span>
          <kbd>⌘Z  ⌘⇧Z</kbd><span>Undo / Redo</span>
          <kbd>⌘D</kbd><span>Duplicate selected shape</span>
          <kbd>Del  ⌫</kbd><span>Delete selected shape</span>
          <kbd>⌘+  ⌘−  ⌘0</kbd><span>Zoom in / out / reset canvas</span>
          <kbd>?</kbd><span>Show / hide this panel</span>
        </div>
      </div>` : ''}
    </div>
    <div class="sm-anno-noteRow">
      <div class="sm-anno-noteK">${escapeHtml(TT('Note'))}</div>
      <textarea class="sm-anno-note" rows="2" placeholder="${escapeHtml(TT('Note…'))}"></textarea>
    </div>
  `;
  modal.appendChild(body);

  // Append to documentElement (<html>) by default — body has overflow:hidden
  // which in Chrome can prevent position:fixed children from covering the full viewport.
  // When a container is passed (e.g. the fullscreen element), append there instead so
  // the modal stays visible inside the fullscreen context.
  const _mountTarget = (container instanceof Element) ? container : document.documentElement;
  if (_mountTarget !== document.documentElement) {
    // Inside a fullscreen container: switch from fixed to absolute positioning so the
    // backdrop fills the container rather than the viewport.
    backdrop.style.setProperty('position', 'absolute', 'important');
    backdrop.style.setProperty('inset', '0', 'important');
    backdrop.style.setProperty('width', '100%', 'important');
    backdrop.style.setProperty('height', '100%', 'important');
    if (docked) {
      backdrop.classList.add('is-docked');
      modal.classList.add('is-docked');
    }
  }
  _mountTarget.appendChild(backdrop);
  // Kick off an initial fit() after first paint so the canvas is sized even if
  // the video/image never fires loadedmetadata (streaming sources, failed URLs).
  // The ResizeObserver also fires fit() but this guarantees it happens early.
  requestAnimationFrame(() => requestAnimationFrame(() => { try { fit?.(); } catch {} }));

  // ===== DOM refs =====
  const img = body.querySelector('img.sm-anno-img');
  const video = body.querySelector('video.sm-anno-video');
  const baseMedia = video || img;
  const frameLockEl = body.querySelector('.sm-anno-frame-lock');
  // Reveal frame-lock once it loads — CSS starts it at opacity:0 to prevent black flash.
  // Reveal immediately for image-only mode (img is the frame source, not a lock overlay).
  if (frameLockEl) {
    const _revealFrameLock = () => {
      try {
        const tc = document.createElement('canvas');
        tc.width = 4; tc.height = 4;
        tc.getContext('2d').drawImage(frameLockEl, 0, 0, 4, 4);
        const px = tc.getContext('2d',{willReadFrequently:true}).getImageData(0,0,4,4).data;
        let l = 0;
        for (let i = 0; i < px.length; i += 4) l += 0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
        // Only show if image has real content (avg luma > 8)
        if (l / (px.length/4) > 8) frameLockEl.style.setProperty('opacity', '1', 'important');
        // If black/empty, leave at opacity:0 — _showNoVideoState will handle it
      } catch { frameLockEl.style.setProperty('opacity', '1', 'important'); }
    };
    if (frameLockEl.complete && frameLockEl.naturalWidth > 0) {
      _revealFrameLock(); // already loaded (cached)
    } else {
      frameLockEl.addEventListener('load', _revealFrameLock, { once: true });
      // Fallback: if load never fires (broken src), still run check after 1s
      setTimeout(() => { if (!frameLockEl.style.opacity || frameLockEl.style.opacity === '0') _revealFrameLock(); }, 1000);
    }
  }
  const canvas = body.querySelector('.sm-anno-canvas');
  const wrap = body.querySelector('.sm-anno-wrap');
  const stage = body.querySelector('.sm-anno-stage');
  const videoPlayBtn    = body.querySelector('.sm-anno-playToggle');
  const videoPrevBtn    = body.querySelector('.sm-anno-stepPrev');
  const videoNextBtn    = body.querySelector('.sm-anno-stepNext');
  // Add the missing range input to the transportHtml template:
  // In the sm-anno-tport-info div, before the time span, add:
  // <input class="sm-anno-transportRange" type="range" min="0" max="100" step="1" value="0" aria-label="Seek">
  // Then the existing querySelector will resolve correctly.
  const videoRange      = body.querySelector('.sm-anno-transportRange');
  const videoTime       = body.querySelector('.sm-anno-transportTime');
  const btnJumpStart    = body.querySelector('.sm-anno-jumpStart');
  const btnJumpEnd      = body.querySelector('.sm-anno-jumpEnd');
  const btnLoop         = body.querySelector('.sm-anno-loopBtn');
  const speedBadge      = body.querySelector('.sm-anno-speed-badge');
  const btnShortcutsToggle = body.querySelector('[data-act="toggleShortcuts"]');
  const ctx2d = ()=> canvas.getContext('2d');

  const getMediaIntrinsicSize = ()=>{
    if (video) {
      return {
        width: video.videoWidth || 1920,
        height: video.videoHeight || 1080,
      };
    }
    return {
      width: img?.naturalWidth || 1920,
      height: img?.naturalHeight || 1080,
    };
  };

  const drawBaseMediaToCanvas = (destCanvas)=>{
    if (!destCanvas || !baseMedia) return false;
    const dctx = destCanvas.getContext('2d');
    if (!dctx) return false;
    try {
      dctx.clearRect(0, 0, destCanvas.width, destCanvas.height);
      dctx.drawImage(baseMedia, 0, 0, destCanvas.width, destCanvas.height);
      return true;
    } catch {
      return false;
    }
  };
  const formatClock = (secs)=>{
    const s = Math.max(0, Number(secs) || 0);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return hrs > 0
      ? `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
      : `${String(mins).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };
  const videoFrameRate = Math.max(1, Number(videoFps) || 24);
  const mediaTimeToFrame = (secs)=> Math.max(0, Math.floor(Math.max(0, Number(secs) || 0) * videoFrameRate + 1e-6));
  const frameToMediaTime = (frame)=>{
    const f = Math.max(0, Number(frame) || 0);
    const biased = Math.max(0, (f + 0.5) / videoFrameRate);
    const dur = Number(video?.duration);
    const maxMediaTime = (Number.isFinite(dur) && dur > 0)
      ? Math.max(0, dur - (0.25 / videoFrameRate))
      : Infinity;
    return Math.min(biased, maxMediaTime);
  };
  // Dismiss the captured-frame overlay the first time the user actively seeks or plays.
  // After that, the live video frame is the reference (user has intentionally moved away).
  const _dismissFrameLock = (()=>{
    let dismissed = false;
    return ()=>{
      if (dismissed || !frameLockEl) return;
      dismissed = true;
      frameLockEl.style.transition = 'opacity 0.15s';
      frameLockEl.style.opacity = '0';
      setTimeout(() => { try { frameLockEl.remove(); } catch {} }, 200);
      // Also dismiss the FRAME LOCKED badge
      const badge = stage?.querySelector('.sm-anno-frame-lock-badge');
      if (badge) {
        badge.style.transition = 'opacity 0.18s';
        badge.style.opacity = '0';
        setTimeout(() => { try { badge.remove(); } catch {} }, 240);
      }
    };
  })();

  const setVideoFrame = (frame, { autoSeek = false } = {})=>{
    if (!video) return;
    // Only dismiss the captured-frame overlay for user-initiated seeks.
    // The initial auto-seek from syncVideoFrame must NOT dismiss it — if the
    // video can't seek (e.g. MSE blob, streaming proxy) the overlay is the only
    // correct frame the user will see.
    if (!autoSeek) _dismissFrameLock();
    try { video.currentTime = frameToMediaTime(frame); } catch {}
  };
  const getVideoClipBounds = ()=>{
    if (!video) return { start: 0, end: 0, hasClipBounds: false };
    const duration = Number(video.duration);
    const durationFrames = Number.isFinite(duration) && duration > 0
      ? Math.max(1, Math.floor(duration * videoFrameRate + 1e-6))
      : 1;
    const rawStartFrame = Number(videoClipStartFrame);
    const rawEndFrame = Number(videoClipEndFrame);
    const startFromTime = mediaTimeToFrame(videoClipStartTime);
    const endFromTime = Math.max(startFromTime + 1, mediaTimeToFrame(videoClipEndTime));
    const hasClipBounds = Number.isFinite(rawStartFrame) && Number.isFinite(rawEndFrame) && rawEndFrame > rawStartFrame;
    let startFrame = hasClipBounds ? Math.max(0, Math.round(rawStartFrame)) : startFromTime;
    let endFrameExclusive = hasClipBounds ? Math.round(rawEndFrame) : endFromTime;
    startFrame = Math.min(startFrame, Math.max(0, durationFrames - 1));
    endFrameExclusive = Math.min(durationFrames, Math.max(startFrame + 1, endFrameExclusive));
    const lastFrame = Math.max(startFrame, endFrameExclusive - 1);
    return { startFrame, endFrameExclusive, lastFrame, durationFrames, hasClipBounds: hasClipBounds || Number.isFinite(videoClipStartTime) || Number.isFinite(videoClipEndTime) };
  };
  const clampVideoFrameToClip = (frame)=>{
    const { startFrame, lastFrame } = getVideoClipBounds();
    const f = Number(frame);
    if (!Number.isFinite(f)) return startFrame;
    return Math.max(startFrame, Math.min(lastFrame, Math.round(f)));
  };
  const enforceVideoClipBounds = ({ pauseAtEnd = false } = {})=>{
    if (!video) return false;
    const { startFrame, lastFrame } = getVideoClipBounds();
    const currentFrame = mediaTimeToFrame(video.currentTime);
    let targetFrame = currentFrame;
    let changed = false;
    if (currentFrame < startFrame) {
      targetFrame = startFrame;
      changed = true;
    } else if (currentFrame > lastFrame || (pauseAtEnd && currentFrame >= lastFrame)) {
      targetFrame = lastFrame;
      changed = true;
    }
    if (changed) {
      // autoSeek=true: clip-bound enforcement is automatic, must not dismiss
      // the captured-frame overlay (user hasn't interacted yet).
      setVideoFrame(targetFrame, { autoSeek: true });
    }
    return changed;
  };
  const updateVideoTransport = ()=>{
    if (!video) return;
    const { startFrame, lastFrame, endFrameExclusive } = getVideoClipBounds();
    const currentAbsFrame = clampVideoFrameToClip(mediaTimeToFrame(video.currentTime));
    const relCurrentFrame = Math.max(0, currentAbsFrame - startFrame);
    const relFrameCount = Math.max(1, endFrameExclusive - startFrame);
    if (videoRange) {
      videoRange.min = '0';
      videoRange.max = String(Math.max(0, relFrameCount - 1));
      videoRange.step = '1';
      videoRange.value = String(Math.max(0, Math.min(Number(videoRange.max || 0), relCurrentFrame)));
    }
    if (videoTime) {
      videoTime.textContent = `${formatClock(relCurrentFrame / videoFrameRate)} / ${formatClock(relFrameCount / videoFrameRate)}`;
    }
    if (videoPlayBtn) {
      videoPlayBtn.innerHTML = video.paused ? _IC.play : _IC.pause;
      videoPlayBtn.title = video.paused ? TT('Play') : TT('Pause');
    }
  };
  const toggleVideoPlayback = async ()=>{
    if (!video) return;
    _dismissFrameLock();
    const { startFrame, lastFrame } = getVideoClipBounds();
    const currentFrame = mediaTimeToFrame(video.currentTime);
    try {
      if (video.paused) {
        if (currentFrame >= lastFrame) {
          setVideoFrame(startFrame);
        } else {
          enforceVideoClipBounds();
        }
        await video.play();
      } else video.pause();
    } catch {}
    updateVideoTransport();
  };
  const stepVideoFrame = (dir)=>{
    if (!video) return;
    try { video.pause(); } catch {}
    try {
      const nextFrame = clampVideoFrameToClip(mediaTimeToFrame(video.currentTime) + dir);
      setVideoFrame(nextFrame);
    } catch {}
    updateVideoTransport();
  };
  const jumpVideoToEdge = (edge)=>{
    if (!video) return;
    const { startFrame, lastFrame } = getVideoClipBounds();
    try { video.pause(); } catch {}
    setVideoFrame(edge === 'end' ? lastFrame : startFrame);
    updateVideoTransport();
  };

  // ── JKL Shuttle ───────────────────────────────────────────────────────────
  const _cancelReverse = () => {
    if (_revRafId) { cancelAnimationFrame(_revRafId); _revRafId = null; }
  };
  const _reverseLoop = (ts) => {
    if (!video || _shuttleSpeed >= 0) return;
    if (_revLastT === 0) _revLastT = ts;
    const elapsed = ts - _revLastT;
    const fps = videoFrameRate || 24;
    const msPerStep = 1000 / (fps * Math.abs(_shuttleSpeed));
    if (elapsed >= msPerStep) {
      const { startFrame } = getVideoClipBounds();
      const cur = mediaTimeToFrame(video.currentTime);
      const next = Math.max(startFrame, cur - Math.max(1, Math.round(Math.abs(_shuttleSpeed))));
      setVideoFrame(next);
      _revLastT = ts;
      if (next <= startFrame) { _setShuttleSpeed(0); return; }
    }
    _revRafId = requestAnimationFrame(_reverseLoop);
  };
  const _setShuttleSpeed = (speed) => {
    _cancelReverse();
    _shuttleSpeed = speed;
    if (speed === 0) {
      try { video?.pause(); if (video) video.playbackRate = 1; } catch {}
    } else if (speed > 0) {
      try {
        if (video) {
          video.playbackRate = speed;
          if (video.paused) {
            const { startFrame, lastFrame } = getVideoClipBounds();
            if (mediaTimeToFrame(video.currentTime) >= lastFrame) setVideoFrame(startFrame);
            video.play().catch(() => {});
          }
        }
      } catch {}
    } else {
      try { video?.pause(); } catch {}
      _revLastT = 0;
      _revRafId = requestAnimationFrame(_reverseLoop);
    }
    // Update speed badge
    if (speedBadge) {
      const abs = Math.abs(speed);
      speedBadge.textContent = speed === 0 ? '1×' : (speed < 0 ? `◀${abs}×` : `${abs}×`);
      speedBadge.classList.toggle('is-fast', abs > 1);
      speedBadge.classList.toggle('is-reverse', speed < 0);
    }
    updateVideoTransport();
  };

  const toolBtns = Array.from(head.querySelectorAll('[data-tool]'));
  const tlCanvas = body.querySelector('.sm-anno-tl-canvas') || null;
  const btnClose = head.querySelector('[data-act="close"]');
  const btnCancel = head.querySelector('[data-act="cancel"]');
  const btnDone = head.querySelector('[data-act="done"]');
  const btnUndo = head.querySelector('[data-act="undo"]');
  const btnRedo = head.querySelector('[data-act="redo"]');
  const btnClear = head.querySelector('[data-act="clear"]');
  const btnTrack          = head.querySelector('[data-act="track"]');
  const btnTrackAll       = head.querySelector('[data-act="trackAll"]');
  const btnDetectAndTrack = head.querySelector('[data-act="detectAndTrack"]');
  const btnTrackSources   = head.querySelector('[data-act="toggleTrackSources"]');
  const btnAiDetectFaces  = body.querySelector('[data-act="aiDetectFaces"]');
  const btnAiDetectScreens= body.querySelector('[data-act="aiDetectScreens"]');
  const btnAiDetectText   = body.querySelector('[data-act="aiDetectText"]');
  const btnAiSmartSuggest = body.querySelector('[data-act="aiSmartSuggest"]');
  const btnAiScanAll      = body.querySelector('[data-act="aiScanAll"]');
  const btnAiDetectKeys   = body.querySelector('[data-act="aiDetectKeys"]');
  const btnAiDetectMatte  = body.querySelector('[data-act="aiDetectMatte"]');
  const btnAiEdgeSnap     = body.querySelector('[data-act="aiEdgeSnap"]');
  const btnAiDetectWire   = body.querySelector('[data-act="aiDetectWire"]');
  const btnAiSamMode      = body.querySelector('[data-act="aiSamMode"]');
  const btnAiDetectML     = body.querySelector('[data-act="aiDetectML"]');
  const btnAiDepthMap     = body.querySelector('[data-act="aiDepthMap"]');
  const btnAiPlanarTrack  = body.querySelector('[data-act="aiPlanarTrack"]');
  const btnAiDepthTrack   = body.querySelector('[data-act="aiDepthTrack"]');
  const btnAiFlowViz      = body.querySelector('[data-act="aiFlowViz"]');
  const btnAiObjFlowViz   = body.querySelector('[data-act="aiObjFlowViz"]');
  const btnAiVelocityHud  = body.querySelector('[data-act="aiVelocityHud"]');
  const btnAiSmoothPath   = body.querySelector('[data-act="aiSmoothPath"]');
  const ntSel = head.querySelector('.sm-anno-nt');
  const trackModeSel = head.querySelector('.sm-anno-trackMode');
  const trackSourcePanel = head.querySelector('.sm-anno-trackSourcePanel');
  const trackScopeSel = head.querySelector('.sm-anno-trackScope');
  const trackRemoteUrlInp = head.querySelector('.sm-anno-trackRemoteUrl');
  const trackRemoteKeyInp = head.querySelector('.sm-anno-trackRemoteKey');
  const trackGithubUrlInp = head.querySelector('.sm-anno-trackGithubUrl');
  const trackCatalogUrlInp = head.querySelector('.sm-anno-trackCatalogUrl');
  // Add the missing SOW input to the head HTML template inside .sm-anno-meta .sm-anno-field,
  // for example after the note-type row:
  // <div class="sm-anno-field">
  //   <span class="sm-anno-k">SoW</span>
  //   <input class="sm-anno-sow" type="text" placeholder="Scope of Work…">
  // </div>
  // Then the existing querySelector will resolve correctly.
  const sowInp = head.querySelector('.sm-anno-sow');
  const shapeCountEl = head.querySelector('.sm-anno-shape-count');
  const shapeNumEl   = head.querySelector('.sm-anno-shape-num');
  const noteInp = body.querySelector('.sm-anno-note');
  if (noteInp) noteInp.value = noteText || '';
  const btnNtEdit = head.querySelector('[data-act="ntEdit"]');
  const colorPick = head.querySelector('.sm-anno-colorpick');
  const swatches = Array.from(head.querySelectorAll('.sm-anno-swatch'));
  const widthSel = head.querySelector('.sm-anno-width'); // null after redesign; kept to avoid breaking old references
  const opRange  = head.querySelector('.sm-anno-opacity');
  const colorbtn  = head.querySelector('[data-act="toggleColor"]');
  const colorpanel = head.querySelector('.sm-anno-colorpanel');
  const colordisc  = head.querySelector('.sm-anno-colordisc');
  const strokebtn  = head.querySelector('[data-act="toggleStroke"]');
  const strokepanel = head.querySelector('.sm-anno-strokepanel');
  const woptBtns   = Array.from(head.querySelectorAll('.sm-anno-wopt'));
  const opvalEl    = head.querySelector('.sm-anno-opval');

  try{ canvas.style.touchAction = 'none'; }catch{}

  // Add a zoom-reset button to the head HTML toolbar (e.g. in sm-anno-toolbar-right):
  // <button class="sm-anno-iconbtn sm-anno-zoom-reset" data-act="resetZoom" title="Reset zoom (⌘0)">100%</button>
  // Then the existing querySelector will resolve correctly.
  const btnResetZoom = head.querySelector('[data-act="resetZoom"]');

  const applyZoom = ()=>{
    try{
      if (!lastFitW || !lastFitH) return;
      const dW = lastFitW * zoomScale;
      const dH = lastFitH * zoomScale;
      wrap.style.width  = dW + 'px';
      wrap.style.height = dH + 'px';
      if (baseMedia) {
        baseMedia.style.width  = dW + 'px';
        baseMedia.style.height = dH + 'px';
      }
      canvas.style.width  = dW + 'px';
      canvas.style.height = dH + 'px';
      if (btnResetZoom) btnResetZoom.textContent = `${Math.round(zoomScale * 100)}%`;
      btnResetZoom?.classList.toggle('sm-anno-zoom-active', Math.abs(zoomScale - 1) > 0.02);
      if (zoomScale <= 1){ stage.scrollLeft = 0; stage.scrollTop = 0; }
    }catch{}
  };

  // ===== State =====
  let tool = String(initialTool || 'pen');
  // Seed from caller so fit() can rescale pre-loaded shapes to the current stage size.
  let logicalW = initialLogicalW > 0 ? initialLogicalW : 0;
  let logicalH = initialLogicalH > 0 ? initialLogicalH : 0;
  let lastFitW = 0, lastFitH = 0;

  const DEFAULT_COLOR = '#ff4c4c';
  // Smart: note-type group → canonical color
  const NT_COLORS = { add: '#2ecc71', remove: '#ff4c4c', change: '#ffd166' };
  let color = DEFAULT_COLOR;
  let width = 4;
  let opacity = 1.0;

  let objects = [];
  let draft = null;
  let selectedId = null;

  let drawing = false;
  let activePointerId = null;
  let spaceDown = false;

  let panning = false;
  let panStartX = 0, panStartY = 0;
  let panScrollL = 0, panScrollT = 0;

  let dragging = false;
  let dragMode = '';
  let dragHandle = '';
  let dragStart = {x:0,y:0};
  let dragOrig = null;
  let dragFrame = 0;
  let _isTracking = false;
  let _trackingAborted = false;
  let _isDetecting = false;
  let _aiToastTimer = null;
  // Pro player state
  let _shuttleSpeed  = 0;      // 0=stopped, +N=forward Nx, -N=reverse Nx
  let _revRafId      = null;   // rAF id for reverse simulation loop
  let _revLastT      = 0;      // last rAF timestamp for reverse pacing
  let _loopPlayback  = false;
  let _tlViewStart   = 0.0;    // fractional clip view for timeline zoom (0-1)
  let _tlViewEnd     = 1.0;

  const states = [];
  let stateIndex = -1;

  // ===== Zoom =====
  let zoomScale = 1.0;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 5.0;

  const genId = ()=> `a_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  const deepClone = (v)=>{ try{ return structuredClone(v); }catch{} return JSON.parse(JSON.stringify(v)); };
  // Preload shapes (for re-edit)
  try{
    if (Array.isArray(initialShapes) && initialShapes.length){
      objects = deepClone(initialShapes);
    }
  }catch{}
  // ── Stroke simplification (Douglas-Peucker) ──────────────────────────────────
  // Reuses the existing distToSeg helper already in scope.
  const _dpSimplifyStroke = (pts, epsilon = 1.2) => {
    if (!Array.isArray(pts) || pts.length <= 3) return pts;
    const keep = new Set([0, pts.length - 1]);
    const walk = (s, e) => {
      if (e <= s + 1) return;
      let maxD = -1, maxI = -1;
      for (let i = s + 1; i < e; i++) {
        const d = distToSeg(pts[i].x, pts[i].y, pts[s].x, pts[s].y, pts[e].x, pts[e].y);
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > epsilon) { keep.add(maxI); walk(s, maxI); walk(maxI, e); }
    };
    walk(0, pts.length - 1);
    return pts.filter((_, i) => keep.has(i));
  };

  // ── IDB draft autosave ────────────────────────────────────────────────────────
  const _DRAFT_DB_NAME  = 'pfx-annotate';
  const _DRAFT_STORE    = 'pfx-annotate-drafts';
  const _DRAFT_DB_VER   = 1;
  const _draftKey       = [title, srcVideoUrl].filter(Boolean).join('::') || 'default';
  let _idb              = null;
  let _draftSaveTimer   = null;
  const _idbOpen = () => new Promise((resolve) => {
    if (_idb) { resolve(_idb); return; }
    try {
      const req = indexedDB.open(_DRAFT_DB_NAME, _DRAFT_DB_VER);
      req.onupgradeneeded = e => { try { e.target.result.createObjectStore(_DRAFT_STORE); } catch {} };
      req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
      req.onerror   = () => resolve(null);
    } catch { resolve(null); }
  });
  const _saveDraft = async () => {
    try {
      const db = await _idbOpen();
      if (!db) return;
      const tx = db.transaction(_DRAFT_STORE, 'readwrite');
      tx.objectStore(_DRAFT_STORE).put({ objects: deepClone(objects), ts: Date.now() }, _draftKey);
    } catch {}
  };
  const _loadDraft = async () => {
    try {
      const db = await _idbOpen();
      if (!db) return null;
      return await new Promise(resolve => {
        const tx  = db.transaction(_DRAFT_STORE, 'readonly');
        const req = tx.objectStore(_DRAFT_STORE).get(_draftKey);
        req.onsuccess = () => resolve(req.result?.objects || null);
        req.onerror   = () => resolve(null);
      });
    } catch { return null; }
  };
  const _clearDraft = async () => {
    try {
      const db = await _idbOpen();
      if (!db) return;
      const tx = db.transaction(_DRAFT_STORE, 'readwrite');
      tx.objectStore(_DRAFT_STORE).delete(_draftKey);
    } catch {}
  };

  const pushState = ()=>{
    try{
      const snap = JSON.stringify(objects);
      if (stateIndex < states.length - 1) states.splice(stateIndex + 1);
      states.push(snap);
      if (states.length > 60) states.shift();
      stateIndex = states.length - 1;
    }catch{}
    if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(_saveDraft, 600);
  };
  const restoreState = (idx)=>{
    try{
      if (idx < 0 || idx >= states.length) return;
      objects = JSON.parse(states[idx] || '[]') || [];
      stateIndex = idx;
      selectedId = null;
      draft = null;
      render(true);
    }catch{}
  };
  const doUndo = ()=>{ if (stateIndex > 0) restoreState(stateIndex - 1); };
  const doRedo = ()=>{ if (stateIndex < states.length - 1) restoreState(stateIndex + 1); };

  // ── Timecode-aware helpers ──────────────────────────────────────────────────
  const currentFrameRef = () => {
    if (!video) return 0;
    return Math.max(0, Math.floor(video.currentTime * videoFrameRate + 1e-6));
  };
  const _getDefaultFrameIn = () => {
    if (!video) return 0;
    const cb = getVideoClipBounds();
    return cb.hasClipBounds ? cb.startFrame : 0;
  };
  const _getDefaultFrameOut = () => {
    if (!video) return 99999;
    const cb = getVideoClipBounds();
    if (cb.hasClipBounds) return cb.lastFrame;
    return Math.max(0, Math.floor((video.duration || 0) * videoFrameRate) - 1);
  };
  const _TRACKABLE_KINDS = new Set(['rect', 'ellipse', 'arrow', 'text', 'stroke', 'erase']);
  const _isTrackableShape = (o)=> !!o && _TRACKABLE_KINDS.has(String(o.kind || '').toLowerCase());
  const _lerpNum = (a, b, t)=> (Number(a) || 0) + ((Number(b) || 0) - (Number(a) || 0)) * t;
  const _captureTrackBase = (o)=>{
    if (!o) return null;
    if (o.kind === 'stroke' || o.kind === 'erase') {
      return { points: deepClone(Array.isArray(o.points) ? o.points : []) };
    }
    if (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'arrow') {
      return { x1: Number(o.x1) || 0, y1: Number(o.y1) || 0, x2: Number(o.x2) || 0, y2: Number(o.y2) || 0 };
    }
    if (o.kind === 'text') {
      return { x: Number(o.x) || 0, y: Number(o.y) || 0 };
    }
    return null;
  };
  const _resolveTrackBase = (o)=>{
    const base = o?.trackBase || _captureTrackBase(o);
    return base ? deepClone(base) : null;
  };
  const _applyTrackOffset = (o, tx = 0, ty = 0)=>{
    const base = _resolveTrackBase(o);
    if (!o || !base) return o;
    if (o.kind === 'stroke' || o.kind === 'erase') {
      return {
        ...o,
        points: (base.points || []).map(p => ({ x: (Number(p.x) || 0) + tx, y: (Number(p.y) || 0) + ty })),
      };
    }
    if (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'arrow') {
      return {
        ...o,
        x1: (Number(base.x1) || 0) + tx,
        y1: (Number(base.y1) || 0) + ty,
        x2: (Number(base.x2) || 0) + tx,
        y2: (Number(base.y2) || 0) + ty,
      };
    }
    if (o.kind === 'text') {
      return {
        ...o,
        x: (Number(base.x) || 0) + tx,
        y: (Number(base.y) || 0) + ty,
      };
    }
    return o;
  };
  const _copyShapeGeometry = (target, src)=>{
    if (!target || !src) return;
    if (target.kind === 'stroke' || target.kind === 'erase') {
      target.points = deepClone(Array.isArray(src.points) ? src.points : []);
      return;
    }
    if (target.kind === 'rect' || target.kind === 'ellipse' || target.kind === 'arrow') {
      target.x1 = Number(src.x1) || 0;
      target.y1 = Number(src.y1) || 0;
      target.x2 = Number(src.x2) || 0;
      target.y2 = Number(src.y2) || 0;
      return;
    }
    if (target.kind === 'text') {
      target.x = Number(src.x) || 0;
      target.y = Number(src.y) || 0;
    }
  };
  const _shiftShapeGeometry = (shape, dx = 0, dy = 0)=>{
    if (!shape) return shape;
    if (shape.kind === 'stroke' || shape.kind === 'erase') {
      return {
        ...shape,
        points: (shape.points || []).map(p => ({ x: (Number(p.x) || 0) + dx, y: (Number(p.y) || 0) + dy })),
      };
    }
    if (shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'arrow') {
      return {
        ...shape,
        x1: (Number(shape.x1) || 0) + dx,
        y1: (Number(shape.y1) || 0) + dy,
        x2: (Number(shape.x2) || 0) + dx,
        y2: (Number(shape.y2) || 0) + dy,
      };
    }
    if (shape.kind === 'text') {
      return {
        ...shape,
        x: (Number(shape.x) || 0) + dx,
        y: (Number(shape.y) || 0) + dy,
      };
    }
    return shape;
  };
  const _getShapeTrackOffset = (shape, visibleShape = null, baseShape = null)=>{
    const visible = visibleShape || shape;
    const base = baseShape || _resolveTrackBase(shape);
    if (!shape || !visible || !base) return { tx: 0, ty: 0 };
    if ((shape.kind === 'stroke' || shape.kind === 'erase') && Array.isArray(visible.points) && Array.isArray(base.points) && visible.points.length && base.points.length) {
      return {
        tx: (Number(visible.points[0].x) || 0) - (Number(base.points[0].x) || 0),
        ty: (Number(visible.points[0].y) || 0) - (Number(base.points[0].y) || 0),
      };
    }
    if ((shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'arrow') && Number.isFinite(visible.x1) && Number.isFinite(base.x1)) {
      return {
        tx: (Number(visible.x1) || 0) - (Number(base.x1) || 0),
        ty: (Number(visible.y1) || 0) - (Number(base.y1) || 0),
      };
    }
    if (shape.kind === 'text') {
      return {
        tx: (Number(visible.x) || 0) - (Number(base.x) || 0),
        ty: (Number(visible.y) || 0) - (Number(base.y) || 0),
      };
    }
    return { tx: 0, ty: 0 };
  };
  const _shiftAbsoluteTrack = (shape, dx = 0, dy = 0)=>{
    if (!shape) return;
    if (Number.isFinite(shape.x1)) shape.x1 += dx;
    if (Number.isFinite(shape.y1)) shape.y1 += dy;
    if (Number.isFinite(shape.x2)) shape.x2 += dx;
    if (Number.isFinite(shape.y2)) shape.y2 += dy;
    if (shape.trackBase) shape.trackBase = _shiftShapeGeometry(shape.trackBase, dx, dy);
    if (Array.isArray(shape.keyframes)) {
      shape.keyframes.forEach(kf => {
        if (Number.isFinite(kf.x1)) kf.x1 += dx;
        if (Number.isFinite(kf.y1)) kf.y1 += dy;
        if (Number.isFinite(kf.x2)) kf.x2 += dx;
        if (Number.isFinite(kf.y2)) kf.y2 += dy;
      });
    }
  };
  const _writeTrackedEditAtFrame = (shape, editedVisible, frame, interaction = 'move')=>{
    if (!shape || !editedVisible) return;
    const hasKeys = Array.isArray(shape.keyframes) && shape.keyframes.length > 0;
    if (!hasKeys) {
      _copyShapeGeometry(shape, editedVisible);
      return;
    }
    const usesOffsetTrack = shape.kind !== 'rect' && shape.kind !== 'ellipse';
    if (interaction === 'move') {
      const visibleNow = _interpShape(shape, frame);
      if (usesOffsetTrack) {
        const dx = bboxOf(editedVisible, ctx2d()).minX - bboxOf(visibleNow, ctx2d()).minX;
        const dy = bboxOf(editedVisible, ctx2d()).minY - bboxOf(visibleNow, ctx2d()).minY;
        const nextBase = _shiftShapeGeometry(_resolveTrackBase(shape) || shape, dx, dy);
        shape.trackBase = _captureTrackBase(nextBase);
        _copyShapeGeometry(shape, nextBase);
      } else {
        const dx = (Number(editedVisible.x1) || 0) - (Number(visibleNow.x1) || 0);
        const dy = (Number(editedVisible.y1) || 0) - (Number(visibleNow.y1) || 0);
        _shiftAbsoluteTrack(shape, dx, dy);
      }
      return;
    }
    if (usesOffsetTrack) {
      const visibleNow = _interpShape(shape, frame);
      const offset = _getShapeTrackOffset(shape, visibleNow, _resolveTrackBase(shape));
      const nextBase = _shiftShapeGeometry(editedVisible, -offset.tx, -offset.ty);
      shape.trackBase = _captureTrackBase(nextBase);
      _copyShapeGeometry(shape, nextBase);
      return;
    }
    // Reshaping a box tracker invalidates the absolute track path.
    _copyShapeGeometry(shape, editedVisible);
    shape.keyframes = [];
  };
  const _interpShape = (o, frame) => {
    const kfs = o.keyframes;
    if (!kfs || kfs.length === 0) return o;
    const sorted = kfs.slice().sort((a, b) => a.frame - b.frame);
    const trackInterpMode = String(o?.trackInterpolation || '').toLowerCase();
    const _applyTrackKeyframe = (target, before, after, t)=>{
      const hasTx = Number.isFinite(before?.tx) || Number.isFinite(after?.tx);
      const hasTy = Number.isFinite(before?.ty) || Number.isFinite(after?.ty);
      if (hasTx || hasTy) {
        const tx = _lerpNum(before?.tx ?? 0, after?.tx ?? before?.tx ?? 0, t);
        const ty = _lerpNum(before?.ty ?? 0, after?.ty ?? before?.ty ?? 0, t);
        return _applyTrackOffset(target, tx, ty);
      }
      return {
        ...target,
        x1: _lerpNum(before?.x1, after?.x1, t),
        y1: _lerpNum(before?.y1, after?.y1, t),
        x2: _lerpNum(before?.x2, after?.x2, t),
        y2: _lerpNum(before?.y2, after?.y2, t),
      };
    };
    if (kfs.length === 1 || frame <= sorted[0].frame)
      return _applyTrackKeyframe(o, sorted[0], sorted[0], 0);
    const last = sorted[sorted.length - 1];
    if (frame >= last.frame)
      return _applyTrackKeyframe(o, last, last, 0);
    let before = sorted[0], after = sorted[1];
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].frame <= frame && sorted[i + 1].frame >= frame) {
        before = sorted[i]; after = sorted[i + 1]; break;
      }
    }
    if (trackInterpMode === 'hold') {
      if (frame < after.frame) return _applyTrackKeyframe(o, before, before, 0);
      return _applyTrackKeyframe(o, after, after, 0);
    }
    const t = (frame - before.frame) / Math.max(1, after.frame - before.frame);
    return _applyTrackKeyframe(o, before, after, t);
  };
  const updateTrackBtnState = () => {
    const sel = objects.find(o => o.id === selectedId);
    const canTrack = hasVideoSource && !!video && _isTrackableShape(sel);
    const trackableCount = objects.filter(o => _isTrackableShape(o)).length;
    if (btnTrack) {
      btnTrack.disabled = !canTrack || _isTracking;
      btnTrack.classList.toggle('is-tracking', _isTracking);
    }
    if (btnTrackAll) {
      btnTrackAll.disabled = !hasVideoSource || !video || trackableCount === 0 || _isTracking;
      btnTrackAll.classList.toggle('is-tracking', _isTracking);
      if (trackableCount > 0) btnTrackAll.title = `Track All — track ${trackableCount} shape${trackableCount > 1 ? 's' : ''}`;
    }
    if (btnDetectAndTrack) {
      btnDetectAndTrack.disabled = !hasVideoSource || !video || _isTracking || _isDetecting;
      btnDetectAndTrack.classList.toggle('is-tracking', _isTracking);
    }
  };

  const __parseSowList = (s)=>{
    const raw = String(s||'').replace(/\r/g,'\n');
    const parts = raw.split(/[\n,;]+/).map(v=>String(v||'').trim()).filter(Boolean);
    const out=[];
    const seen=new Set();
    for (const v of parts){
      const key=v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  };
  const __formatSow = (list, fallbackRaw='')=>{
    const arr = Array.isArray(list)?list.filter(Boolean).map(v=>String(v).trim()).filter(Boolean):[];
    if (arr.length) return arr.join('; ');
    const f = String(fallbackRaw||'').trim();
    return f;
  };

  const readMeta = ()=>{
    const val = (ntSel && ntSel.value) ? String(ntSel.value) : '';
    let g='', t='';
    if (val.includes('|')){ const parts = val.split('|'); g = parts[0]||''; t = parts.slice(1).join('|')||''; }
    const sow = sowInp ? String(sowInp.value||'') : '';
    const sowList = __parseSowList(sow);
    const note = noteInp ? String(noteInp.value||'') : '';
    return { g, t, sow, sowList, note };
  };

  const _getPfxPolicyToken = ()=>{
    try {
      return String(
        window.PFX_AUTH?.getPfxSession?.()?.session?.token
        || window.PFX_PERMISSIONS?.getSession?.()?.session?.token
        || ''
      ).trim();
    } catch {}
    return '';
  };

  let _trackSourceCache = null;
  let _trackSourceCacheStamp = 0;
  const _saveTrackCfg = ()=>{
    try{
      localStorage.setItem(TRACK_CFG_KEY, JSON.stringify(trackCfg));
    }catch{}
    _trackSourceCache = null;
    _trackSourceCacheStamp = 0;
  };
  const _updateTrackCfgFromUi = ()=>{
    trackCfg = {
      ...trackCfg,
      mode: String(trackModeSel?.value || trackCfg.mode || 'auto'),
      scope: String(trackScopeSel?.value || trackCfg.scope || 'all'),
      remoteUrl: String(trackRemoteUrlInp?.value || '').trim(),
      remoteKey: String(trackRemoteKeyInp?.value || '').trim(),
      githubManifestUrl: String(trackGithubUrlInp?.value || '').trim(),
      apiCatalogUrl: String(trackCatalogUrlInp?.value || '').trim(),
    };
    _saveTrackCfg();
  };
  const _normalizeTrackSources = (raw, sourceLabel = 'catalog')=>{
    const src = Array.isArray(raw) ? raw : (Array.isArray(raw?.providers) ? raw.providers : []);
    const out = [];
    for (const item of src) {
      if (!item || typeof item !== 'object') continue;
      const url = String(item.url || item.endpoint || '').trim();
      const proxy = !!item.proxy || String(item.source || sourceLabel || '').toLowerCase() === 'protected';
      if (!url && !proxy) continue;
      out.push({
        id: String(item.id || item.name || url),
        label: String(item.label || item.name || item.id || 'Remote Provider'),
        url,
        proxy,
        source: String(item.source || sourceLabel || 'catalog'),
        apiKey: String(item.apiKey || '').trim(),
        apiKeyHeader: String(item.apiKeyHeader || 'Authorization').trim(),
        hints: Array.isArray(item.hints) ? item.hints.map(v => String(v || '').trim()).filter(Boolean) : [],
      });
    }
    return out;
  };
  const _discoverTrackSources = async ({ force = false } = {})=>{
    const now = Date.now();
    if (!force && _trackSourceCache && (now - _trackSourceCacheStamp) < 30000) return _trackSourceCache;
    const found = [];
    const seen = new Set();
    const pushOne = (item)=>{
      if (!item || (!item.url && !item.proxy)) return;
      const key = `${item.id || ''}::${item.url || item.source || 'protected'}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push(item);
    };
    try{
      const secureCatalog = await window.pfxPolicyApi?.annotateCatalog?.(_getPfxPolicyToken());
      _normalizeTrackSources(secureCatalog, 'protected').forEach(pushOne);
    }catch{}
    if (trackCfg.remoteUrl) {
      pushOne({
        id: 'configured-remote',
        label: 'Configured Remote API',
        url: trackCfg.remoteUrl,
        source: 'api',
        apiKey: trackCfg.remoteKey || '',
        apiKeyHeader: 'Authorization',
      });
    }
    try{
      const winSources = window.__PFX_ANNOTATE_TRACK_SOURCES;
      _normalizeTrackSources(winSources, 'window').forEach(pushOne);
    }catch{}
    const catalogs = [
      { url: trackCfg.githubManifestUrl, source: 'github' },
      { url: trackCfg.apiCatalogUrl, source: 'api' },
    ].filter(v => String(v.url || '').trim());
    for (const catalog of catalogs) {
      try{
        const res = await fetch(catalog.url, { cache: 'no-store' });
        if (!res.ok) continue;
        const json = await res.json();
        _normalizeTrackSources(json, catalog.source).forEach(pushOne);
      }catch{}
    }
    _trackSourceCache = found;
    _trackSourceCacheStamp = now;
    return found;
  };
  const _scopeAllowsRemote = ()=>{
    const scope = String(trackCfg.scope || 'all');
    return scope === 'all' || scope === 'remote' || scope === 'catalog';
  };
  const _scopeAllowsLocal = ()=>{
    const scope = String(trackCfg.scope || 'all');
    return scope === 'all' || scope === 'local';
  };
  const _captureFrameDataUrl = (maxWidth = 640)=>{
    try{
      const srcW = video ? (video.videoWidth  || logicalW) : (baseMedia?.naturalWidth  || logicalW);
      const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
      const scale = srcW > maxWidth ? (maxWidth / Math.max(1, srcW)) : 1;
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const oc = _makeOffscreen(w, h);
      oc.getContext('2d').drawImage(baseMedia, 0, 0, w, h);
      return oc.toDataURL('image/jpeg', 0.82);
    }catch{}
    return '';
  };
  const _normalizeTrackedRect = (raw)=>{
    if (!raw || typeof raw !== 'object') return null;
    const x1 = Number(raw.x1 ?? raw.left ?? raw.x ?? raw.minX);
    const y1 = Number(raw.y1 ?? raw.top ?? raw.y ?? raw.minY);
    const x2Raw = raw.x2 ?? raw.right ?? raw.maxX;
    const y2Raw = raw.y2 ?? raw.bottom ?? raw.maxY;
    const w = Number(raw.w ?? raw.width ?? 0);
    const h = Number(raw.h ?? raw.height ?? 0);
    const x2 = Number.isFinite(Number(x2Raw)) ? Number(x2Raw) : (x1 + w);
    const y2 = Number.isFinite(Number(y2Raw)) ? Number(y2Raw) : (y1 + h);
    if (![x1,y1,x2,y2].every(Number.isFinite)) return null;
    return { x1, y1, x2, y2, score: Number(raw.score ?? raw.confidence ?? 0) || 0 };
  };
  const _pickNearestTrackedRect = (rects, predPos)=>{
    if (!Array.isArray(rects) || !rects.length) return null;
    const cx = (predPos.x1 + predPos.x2) / 2;
    const cy = (predPos.y1 + predPos.y2) / 2;
    const pw = Math.max(1, Math.abs(predPos.x2 - predPos.x1));
    const ph = Math.max(1, Math.abs(predPos.y2 - predPos.y1));
    let best = null;
    let bestScore = Infinity;
    for (const rect of rects) {
      const n = _normalizeTrackedRect(rect);
      if (!n) continue;
      const rcx = (n.x1 + n.x2) / 2;
      const rcy = (n.y1 + n.y2) / 2;
      const rw = Math.max(1, Math.abs(n.x2 - n.x1));
      const rh = Math.max(1, Math.abs(n.y2 - n.y1));
      const dist = Math.hypot(rcx - cx, rcy - cy);
      const sizePenalty = Math.abs(rw - pw) + Math.abs(rh - ph);
      const scorePenalty = Number.isFinite(n.score) ? (100 - Math.min(100, n.score)) : 50;
      const total = dist + sizePenalty * 0.18 + scorePenalty * 0.35;
      if (total < bestScore) { bestScore = total; best = n; }
    }
    return best;
  };
  const _lockTrackedBoxSize = (rect, width, height)=>{
    const w = Math.max(1, Math.abs(Number(width) || 0));
    const h = Math.max(1, Math.abs(Number(height) || 0));
    const halfW = w / 2;
    const halfH = h / 2;
    const minCx = halfW;
    const maxCx = Math.max(halfW, logicalW - halfW);
    const minCy = halfH;
    const maxCy = Math.max(halfH, logicalH - halfH);
    const rawCx = ((Number(rect?.x1) || 0) + (Number(rect?.x2) || 0)) / 2;
    const rawCy = ((Number(rect?.y1) || 0) + (Number(rect?.y2) || 0)) / 2;
    const cx = Math.max(minCx, Math.min(maxCx, rawCx));
    const cy = Math.max(minCy, Math.min(maxCy, rawCy));
    return {
      ...rect,
      x1: cx - halfW,
      y1: cy - halfH,
      x2: cx + halfW,
      y2: cy + halfH,
    };
  };
  const _inferTrackingHint = (shape)=>{
    const meta = shape?.meta || {};
    const hintText = [
      meta.g, meta.t, meta.sow, noteInp?.value || '',
      ntSel?.value || '',
    ].join(' ').toLowerCase();
    if (/(face|head|beauty|skin|person|actor)/.test(hintText)) return 'faces';
    if (/(screen|monitor|display|phone|tablet|ui|device)/.test(hintText)) return 'screens';
    if (/(text|subtitle|caption|title|logo|burn[- ]?in)/.test(hintText)) return 'text';
    return '';
  };
  const _trackTelemetry = new Map();
  const _sampleTrackingStats = (vid, rect, size = 36)=>{
    try{
      const patch = _extractRegion(vid, rect, size);
      const edges = _computeSobelEdges(patch, size);
      const d = patch.data;
      let lumSum = 0;
      let edgeSum = 0;
      let minLum = 255;
      let maxLum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        lumSum += lum;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }
      for (let i = 0; i < edges.length; i++) edgeSum += edges[i];
      const pxCount = Math.max(1, d.length / 4);
      return {
        avgLuma: lumSum / pxCount,
        contrast: maxLum - minLum,
        edgeMean: edgeSum / Math.max(1, edges.length),
      };
    }catch{
      return { avgLuma: 72, contrast: 32, edgeMean: 24 };
    }
  };
  const _describeTrackingProfile = (profile)=>{
    if (!profile) return '';
    const tags = [];
    if (profile.hint === 'screens') tags.push('screen');
    else if (profile.hint === 'text') tags.push('text');
    else if (profile.hint === 'faces') tags.push('face');
    if (profile.small) tags.push('small');
    if (profile.dark) tags.push('dark');
    if (profile.lowTexture) tags.push('low-texture');
    if (profile.preferFlow) tags.push('flow-first');
    else if (profile.preferFeature) tags.push('feature-first');
    return tags.slice(0, 4).join(' · ');
  };
  const _buildTrackingProfile = (shape, rect)=>{
    const hint = _inferTrackingHint(shape);
    const width = Math.max(1, Math.abs((rect?.x2 || 0) - (rect?.x1 || 0)));
    const height = Math.max(1, Math.abs((rect?.y2 || 0) - (rect?.y1 || 0)));
    const minDim = Math.min(width, height);
    const aspect = Math.max(width, height) / Math.max(1, minDim);
    const stats = video ? _sampleTrackingStats(video, rect, 36) : { avgLuma: 72, contrast: 32, edgeMean: 24 };
    const dark = stats.avgLuma < 34;
    const lowTexture = stats.edgeMean < 18 || stats.contrast < 28;
    const small = minDim < 24;
    const thin = aspect > 3.2;
    const preferFlow = dark || lowTexture;
    const preferFeature = !preferFlow && (hint === 'screens' || hint === 'text' || stats.edgeMean >= 28);
    let label = 'Balanced';
    if (hint === 'screens') label = 'Screen Lock';
    else if (hint === 'text') label = 'Text Lock';
    else if (preferFlow) label = 'Flow First';
    else if (small) label = 'Small Target';
    else if (preferFeature) label = 'Feature Lock';

    let templateSize = 48;
    if (small) templateSize = 58;
    if (hint === 'text') templateSize = Math.max(templateSize, 60);
    if (hint === 'screens') templateSize = Math.max(templateSize, 56);
    if (preferFlow) templateSize = Math.max(templateSize, 62);

    let searchScales = null;
    if (small) searchScales = [0.56, 0.66, 0.76, 0.88, 1.0, 1.1, 1.22, 1.36];
    else if (hint === 'text') searchScales = [0.78, 0.88, 0.94, 1.0, 1.06, 1.12, 1.18];
    else if (hint === 'screens') searchScales = [0.84, 0.92, 1.0, 1.08, 1.16];
    else if (preferFlow) searchScales = [0.68, 0.80, 0.90, 1.0, 1.12, 1.24, 1.36];

    const basePad = Math.max(
      small ? 44 : (preferFlow ? 38 : (hint === 'text' ? 24 : 28)),
      Math.round(minDim * (small ? 2.0 : preferFlow ? 0.9 : hint === 'screens' ? 0.72 : hint === 'text' ? 0.62 : 0.55))
    );
    const maxPad = Math.max(
      basePad + 52,
      Math.round(minDim * (small ? 2.8 : preferFlow ? 1.8 : thin ? 1.55 : 1.25))
    );

    return {
      hint,
      label,
      dark,
      lowTexture,
      small,
      thin,
      preferFlow,
      preferFeature,
      templateSize,
      searchScales,
      basePad,
      maxPad,
      assistEvery: small || preferFlow ? 3 : (hint === 'text' ? 4 : 6),
      flowPrimaryThreshold: preferFlow ? 0.38 : 0.55,
      lkPrimaryThreshold: preferFlow ? 0.28 : 0.55,
      particlePrimaryThreshold: preferFlow ? 0.32 : 0.45,
      stableConfidence: preferFlow ? 0.50 : 0.58,
      occlusionEnterConfidence: preferFlow ? 0.16 : 0.22,
      updateEvery: hint === 'text' ? 4 : 3,
      updateBlend: hint === 'text' ? 0.14 : 0.20,
      stats,
    };
  };
  const _setTrackTelemetry = (shapeId, next = {})=>{
    if (!shapeId) return;
    const prev = _trackTelemetry.get(shapeId) || {};
    _trackTelemetry.set(shapeId, { ...prev, ...next, stamp: Date.now() });
    try { _updateCtxStrip?.(); } catch {}
  };
  const _remoteTrackReacquire = async ({ shape, predPos, frame, provider, hint })=>{
    if (!provider?.url && !provider?.proxy) return null;
    const imageDataUrl = _captureFrameDataUrl(720);
    if (!imageDataUrl) return null;
    const requestPayload = {
      action: 'reacquire',
      engine: trackCfg.mode,
      sourceScope: trackCfg.scope,
      hint,
      title,
      frame,
      fps: videoFrameRate,
      logicalWidth: logicalW,
      logicalHeight: logicalH,
      predictedBox: predPos,
      shape: { id: shape?.id || '', kind: shape?.kind || 'rect' },
      noteType: readMeta(),
      imageDataUrl,
    };
    if (provider?.proxy) {
      try{
        const json = await window.pfxPolicyApi?.annotateTrackProxy?.({
          providerId: provider.id,
          payload: requestPayload,
          pfxToken: _getPfxPolicyToken(),
        });
        return _pickNearestTrackedRect(
          Array.isArray(json?.boxes) ? json.boxes : [json?.box || json?.rect || json],
          predPos
        );
      }catch{
        return null;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try{
      const headers = { 'Content-Type': 'application/json' };
      const apiKey = String(provider.apiKey || '').trim();
      const apiKeyHeader = String(provider.apiKeyHeader || 'Authorization').trim() || 'Authorization';
      if (apiKey) headers[apiKeyHeader] = apiKeyHeader.toLowerCase() === 'authorization' && !/^bearer\s/i.test(apiKey) ? `Bearer ${apiKey}` : apiKey;
      const res = await fetch(provider.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      return _pickNearestTrackedRect(
        Array.isArray(json?.boxes) ? json.boxes : [json?.box || json?.rect || json],
        predPos
      );
    }catch{
      return null;
    }finally{
      clearTimeout(timer);
    }
  };

  // ===== Meta ↔ Shapes binding =====
  // Users often draw first, then decide Note Type / Scope later.
  // - When a shape is selected (Move tool), changing Type/Scope updates that shape's meta.
  // - When selecting a shape, if it has meta, reflect it back into the controls.
  let __metaProgrammatic = false;
  let __metaPushTimer = null;
  const __shapeMetaFromUi = ()=>{
    const m = readMeta();
    return { g: m.g || '', t: m.t || '', sow: m.sow || '', sowList: Array.isArray(m.sowList) ? m.sowList : [] };
  };
  const __setUiFromShapeMeta = (meta)=>{
    try{
      if (!meta) return;
      __metaProgrammatic = true;
      // Note Type
      try{
        const g = String(meta.g||'').trim().toLowerCase();
        const t = String(meta.t||'').trim();
        const val = (g && t) ? `${g}|${t}` : '';
        if (ntSel && typeof val === 'string') ntSel.value = val;
      }catch{}
      // Scope
      try{
        const sowText = (Array.isArray(meta.sowList) && meta.sowList.length) ? __formatSow(meta.sowList, meta.sow) : String(meta.sow||'');
        if (sowInp) sowInp.value = sowText;
      }catch{}
    }finally{
      setTimeout(()=>{ __metaProgrammatic = false; }, 0);
    }
  };
  const __applyUiMetaToSelectedShape = ()=>{
    try{
      if (__metaProgrammatic) return;
      if (!selectedId) return;
      const idx = objects.findIndex(o=>o && o.id === selectedId);
      if (idx < 0) return;
      const om = __shapeMetaFromUi();
      objects[idx].meta = om;
      render(true);
      try{ if (__metaPushTimer) clearTimeout(__metaPushTimer); }catch{}
      __metaPushTimer = setTimeout(()=>{ try{ pushState(); }catch{} }, 350);
    }catch{}
  };

  // ===== Style ↔ Shapes binding =====
  // Allow users to draw first, then refine style (color/width/opacity) later.
  // - When a shape is selected (Move tool), changing style controls updates that shape's style.
  // - When selecting a shape, reflect its style back into the controls.
  let __styleProgrammatic = false;
  let __stylePushTimer = null;
  const __clamp = (v, lo, hi)=> Math.max(lo, Math.min(hi, v));
  const __nearestWidthOption = (w)=>{
    const vals = [2, 4, 7, 11];
    let best = vals[1]; // default M
    let bestD = Infinity;
    for (const v of vals){
      const d = Math.abs(v - (w||0));
      if (d < bestD){ best = v; bestD = d; }
    }
    return String(best);
  };

  // Stroke-weight visual map: data-w value → SVG stroke-width on preview line
  const __strokePreviewW = { '2':1.5, '4':3, '7':6, '11':10 };

  const __setWidth = (w)=>{
    width = Number(w) || 4;
    const nearest = __nearestWidthOption(width);
    woptBtns.forEach(b => b.classList.toggle('is-active-w', String(b.getAttribute('data-w')) === nearest));
    const strokeLine = head.querySelector('.sm-anno-strokepreview line');
    if (strokeLine) strokeLine.setAttribute('stroke-width', String(__strokePreviewW[nearest] || 3));
  };
  const __setUiFromStyle = (style)=>{
    try{
      __styleProgrammatic = true;
      const c = String(style?.color || color || DEFAULT_COLOR);
      const w = parseFloat(style?.width ?? width ?? 4) || 4;
      const o = __clamp(parseFloat(style?.opacity ?? opacity ?? 1) || 1, 0.10, 1.00);
      color = c; width = w; opacity = o;
      if (colorPick) colorPick.value = c;
      if (colordisc) colordisc.style.background = c;
      swatches.forEach(s=>{
        const sc = String(s.getAttribute('data-color')||'').toLowerCase();
        s.classList.toggle('is-active', sc && sc === c.toLowerCase());
      });
      __setWidth(w);
      if (opRange){ opRange.value = String(o); if (opvalEl) opvalEl.textContent = `${Math.round(o*100)}%`; }
    }catch{}
    finally{ setTimeout(()=>{ __styleProgrammatic = false; }, 0); }
  };
  const __applyUiStyleToSelectedShape = ()=>{
    try{
      if (__styleProgrammatic) return;
      if (!selectedId) return;
      const idx = objects.findIndex(o=>o && o.id === selectedId);
      if (idx < 0) return;
      const o = objects[idx];
      const cur = o.style || {};
      o.style = { ...cur, color, width, opacity };
      // For text objects, treat width as a convenient "size" knob.
      if (o.kind === 'text'){
        o.fontSize = Math.max(14, (o.style?.width ?? width) * 4);
      }
      render(true);
      try{ if (__stylePushTimer) clearTimeout(__stylePushTimer); }catch{}
      __stylePushTimer = setTimeout(()=>{ try{ pushState(); }catch{} }, 350);
    }catch{}
  };

  const emitMetaChange = ()=>{
    try{
      __applyUiMetaToSelectedShape();
      if (typeof onMetaChange === 'function') onMetaChange(readMeta());
    }catch{}
  };

  // Smart: selecting a note-type group auto-sets the canonical color
  const __applyNtColor = ()=>{
    try{
      const grp = String(ntSel?.value || '').split('|')[0] || '';
      if (grp && NT_COLORS[grp]) __setColor(NT_COLORS[grp]);
    }catch{}
  };
  // Quick note-type select by group key (used by 1/2/3 shortcuts)
  const __selectNtGroup = (groupKey)=>{
    try{
      if (!ntSel) return;
      const opts = Array.from(ntSel.options);
      const match = opts.find(o => String(o.value).startsWith(groupKey + '|'));
      if (match){ ntSel.value = match.value; emitMetaChange(); __applyNtColor(); }
    }catch{}
  };
  if (ntSel) ntSel.addEventListener('change', ()=>{ emitMetaChange(); __applyNtColor(); });
  if (sowInp) sowInp.addEventListener('input', emitMetaChange);
  if (noteInp) noteInp.addEventListener('input', emitMetaChange);
  if (btnNtEdit) btnNtEdit.addEventListener('click', ()=>{ try{ if (typeof window.PFX_openNoteTypesModal === 'function') window.PFX_openNoteTypesModal(); }catch{} });

  const setActiveTool = ()=>{ toolBtns.forEach(b => { const on = (b.dataset.tool === tool); b.classList.toggle('active', on); b.classList.toggle('is-active-tool', on); }); };
  const setTool = (t)=>{ tool = t; setActiveTool(); _updateSmartCursor(); if (tool!=='move') selectedId = null; render(true); updateTrackBtnState(); };

  const applyStroke = (ctx, style, isHighlight)=>{
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style?.color || color;
    ctx.lineWidth = style?.width ?? width;
    ctx.globalAlpha = style?.opacity ?? opacity;
    if (isHighlight) ctx.globalAlpha = Math.max(0.15, (style?.opacity ?? opacity) * 0.35);
  };

  const distToSeg = (px,py, x1,y1,x2,y2)=>{
    const vx = x2-x1, vy = y2-y1;
    const wx = px-x1, wy = py-y1;
    const c1 = vx*wx + vy*wy;
    if (c1 <= 0) return Math.hypot(px-x1, py-y1);
    const c2 = vx*vx + vy*vy;
    if (c2 <= c1) return Math.hypot(px-x2, py-y2);
    const b = c1 / c2;
    const bx = x1 + b*vx, by = y1 + b*vy;
    return Math.hypot(px-bx, py-by);
  };

  const bboxOf = (o, ctx)=>{
    if (!o) return {minX:0,minY:0,maxX:0,maxY:0};
    const clamp = (v, lo, hi)=> Math.max(lo, Math.min(hi, v));
    const W = logicalW || canvas.getBoundingClientRect().width || 1;
    const H = logicalH || canvas.getBoundingClientRect().height || 1;
    if (o.kind === 'stroke' || o.kind === 'erase'){
      const pts = Array.isArray(o.points) ? o.points : [];
      if (!pts.length) return {minX:0,minY:0,maxX:0,maxY:0};
      let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
      pts.forEach(p=>{ minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); });
      const pad = Math.max(6, (o.style?.width ?? width) + 6);
      return {minX:clamp(minX-pad,0,W), minY:clamp(minY-pad,0,H), maxX:clamp(maxX+pad,0,W), maxY:clamp(maxY+pad,0,H)};
    }
    if (o.kind === 'rect' || o.kind === 'ellipse'){
      const x1=o.x1??0,y1=o.y1??0,x2=o.x2??0,y2=o.y2??0;
      const minX=Math.min(x1,x2), minY=Math.min(y1,y2), maxX=Math.max(x1,x2), maxY=Math.max(y1,y2);
      const pad = Math.max(6, (o.style?.width ?? width) + 6);
      return {minX:clamp(minX-pad,0,W), minY:clamp(minY-pad,0,H), maxX:clamp(maxX+pad,0,W), maxY:clamp(maxY+pad,0,H)};
    }
    if (o.kind === 'arrow'){
      const x1=o.x1??0,y1=o.y1??0,x2=o.x2??0,y2=o.y2??0;
      const minX=Math.min(x1,x2), minY=Math.min(y1,y2), maxX=Math.max(x1,x2), maxY=Math.max(y1,y2);
      const pad = Math.max(10, (o.style?.width ?? width) * 3);
      return {minX:clamp(minX-pad,0,W), minY:clamp(minY-pad,0,H), maxX:clamp(maxX+pad,0,W), maxY:clamp(maxY+pad,0,H)};
    }
    if (o.kind === 'text'){
      const x=o.x??0,y=o.y??0;
      const fs = o.fontSize ?? Math.max(14, (o.style?.width ?? width) * 4);
      const t = String(o.text||'');
      let w = 140;
      try{
        if (ctx){
          ctx.save();
          ctx.font = `${fs}px "NetflixSans", system-ui, sans-serif`;
          w = ctx.measureText(t).width + 6;
          ctx.restore();
        }
      }catch{}
      return {minX:x, minY:y, maxX:x+w, maxY:y+fs+6};
    }
    return {minX:0,minY:0,maxX:0,maxY:0};
  };
  const _trackRectOf = (o, ctx)=>{
    const bb = bboxOf(o, ctx);
    const minX = Math.min(bb.minX, bb.maxX);
    const minY = Math.min(bb.minY, bb.maxY);
    const maxX = Math.max(bb.minX, bb.maxX);
    const maxY = Math.max(bb.minY, bb.maxY);
    let w = Math.max(12, maxX - minX);
    let h = Math.max(12, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      x1: Math.max(0, cx - w / 2),
      y1: Math.max(0, cy - h / 2),
      x2: Math.min(logicalW, cx + w / 2),
      y2: Math.min(logicalH, cy + h / 2),
    };
  };

  const kindLabelForObj = (o)=>{
    try{
      const k = String(o?.kind||'').toLowerCase();
      const mode = String(o?.mode||'').toLowerCase();
      if (k==='rect') return TT('Rectangle');
      if (k==='ellipse') return TT('Circle');
      if (k==='arrow') return TT('Arrow');
      if (k==='text') return TT('Text');
      if (k==='stroke') return mode==='highlighter' ? TT('Highlighter') : TT('Pen');
      if (k==='erase') return TT('Eraser');
      return TT('Mark');
    }catch{}
    return '';
  };

  const drawMetaLabel = (ctx, meta, minX, minY, maxX, maxY, styleColor, idx, kindLabel)=>{
    try{
      if (!meta || (!meta.g && !meta.t && !meta.sow)) return;
      const gKey = meta.g ? (meta.g[0].toUpperCase() + meta.g.slice(1)) : '';
      const gLabel = gKey ? TT(gKey) : '';
      const tLabel = meta.t ? TT(meta.t) : '';
      const line1 = (gLabel && tLabel) ? `${gLabel}: ${tLabel}` : (tLabel || '');
      const sowText = (Array.isArray(meta.sowList) && meta.sowList.length) ? meta.sowList.join('; ') : (meta.sow || '');
      const line2 = sowText ? `${TT('Scope')}: ${sowText}` : '';
      // Format: "1) Add: Matte" — shape kind is intentionally omitted
      const num = (Number.isFinite(idx) && idx >= 0) ? `${idx+1})` : '';
      const headLine = num ? (line1 ? `${num} ${line1}` : num) : line1;
      const lines = [headLine, line2].filter(Boolean);
      if (!lines.length) return;

      ctx.save();
      ctx.font = '12px "NetflixSans", system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.textBaseline = 'top';
      const padX = 8, padY = 6;
      const lh = 14;
      const w = Math.max(...lines.map(t=>ctx.measureText(t).width)) + padX*2;
      const h = lines.length*lh + padY*2;

      const W = logicalW || canvas.getBoundingClientRect().width || 1;
      const H = logicalH || canvas.getBoundingClientRect().height || 1;

      // Try four candidate positions; pick the first that doesn't overlap an already-drawn label.
      const candidates = [
        [minX, maxY + 8],
        [minX, minY - h - 8],
        [maxX + 8, minY],
        [minX - w - 8, minY],
      ];
      let x, y;
      for (const [cx0, cy0] of candidates) {
        const cx = Math.max(6, Math.min(cx0, W - w - 6));
        const cy = Math.max(6, Math.min(cy0, H - h - 6));
        const hit = Array.isArray(_labelOccupied) && _labelOccupied.some(r =>
          cx < r.x + r.w + 3 && cx + w > r.x - 3 && cy < r.y + r.h + 3 && cy + h > r.y - 3
        );
        if (!hit) { x = cx; y = cy; break; }
      }
      if (x == null) {
        x = Math.max(6, Math.min(minX, W - w - 6));
        y = Math.max(6, Math.min(maxY + 8, H - h - 6));
      }
      if (Array.isArray(_labelOccupied)) _labelOccupied.push({ x, y, w, h });

      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      const r=6;
      const rr=(x,y,w,h)=>{ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);};
      rr(x,y,w,h);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.fillStyle = styleColor || color;
      let ty = y + padY;
      lines.forEach(t=>{ ctx.fillText(t, x+padX, ty); ty += lh; });
      ctx.restore();
    }catch{}
  };

  const drawArrow = (ctx, x1,y1,x2,y2, style)=>{
    const w = style?.width ?? width;
    const headLen = Math.max(10, w*3);
    const dx = x2-x1; const dy=y2-y1;
    const ang = Math.atan2(dy,dx);
    ctx.beginPath();
    ctx.moveTo(x1,y1);
    ctx.lineTo(x2,y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2 - headLen*Math.cos(ang - Math.PI/7), y2 - headLen*Math.sin(ang - Math.PI/7));
    ctx.lineTo(x2 - headLen*Math.cos(ang + Math.PI/7), y2 - headLen*Math.sin(ang + Math.PI/7));
    ctx.lineTo(x2,y2);
    ctx.closePath();
    ctx.fillStyle = style?.color || color;
    ctx.globalAlpha = style?.opacity ?? opacity;
    ctx.fill();
  };

  const renderObj = (ctx, o, showGuides, idx)=>{
    if (!o) return;
    ctx.save();
    if (o.kind === 'erase') ctx.globalCompositeOperation = 'destination-out';
    else ctx.globalCompositeOperation = 'source-over';

    const style = o.style || {};
    const isHighlight = (o.kind === 'stroke' && o.mode === 'highlighter');

    if (o.kind === 'stroke' || o.kind === 'erase'){
      applyStroke(ctx, style, isHighlight);
      if (o.kind === 'erase'){
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(10, (style.width ?? width) * 3);
      }
      const pts = Array.isArray(o.points) ? o.points : [];
      if (pts.length){
        ctx.beginPath();
        if (pts.length === 1) {
          const r = Math.max(0.5, (style?.width ?? width) / 2);
          ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
          ctx.fillStyle = style?.color || color;
          ctx.globalAlpha = style?.opacity ?? opacity;
          ctx.fill();
        } else {
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2;
            const my = (pts[i].y + pts[i + 1].y) / 2;
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
          }
          ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
          ctx.stroke();
        }
      }
      // If stroke has meta, draw the same numbered label as Inspector.
      if (o?.meta && (o.meta.g || o.meta.t || o.meta.sow || (Array.isArray(o.meta.sowList) && o.meta.sowList.length))){
        const bb = bboxOf(o, ctx);
        drawMetaLabel(ctx, o.meta, bb.minX,bb.minY,bb.maxX,bb.maxY, style.color, idx, kindLabelForObj(o));
      }
    } else if (o.kind === 'rect'){
      applyStroke(ctx, style, false);
      const mnx = Math.min(o.x1,o.x2), mny = Math.min(o.y1,o.y2);
      const w = Math.abs(o.x2-o.x1), h = Math.abs(o.y2-o.y1);
      ctx.strokeRect(mnx,mny,w,h);
      drawMetaLabel(ctx, o.meta, mnx,mny, mnx+w, mny+h, style.color, idx, kindLabelForObj(o));
    } else if (o.kind === 'ellipse'){
      applyStroke(ctx, style, false);
      const cx=(o.x1+o.x2)/2, cy=(o.y1+o.y2)/2;
      const rx=Math.abs(o.x2-o.x1)/2, ry=Math.abs(o.y2-o.y1)/2;
      ctx.beginPath();
      ctx.ellipse(cx,cy,Math.max(1,rx),Math.max(1,ry),0,0,Math.PI*2);
      ctx.stroke();
      drawMetaLabel(ctx, o.meta, Math.min(o.x1,o.x2),Math.min(o.y1,o.y2),Math.max(o.x1,o.x2),Math.max(o.y1,o.y2), style.color, idx, kindLabelForObj(o));
    } else if (o.kind === 'arrow'){
      applyStroke(ctx, style, false);
      drawArrow(ctx, o.x1,o.y1,o.x2,o.y2, style);
      const bb = bboxOf(o, ctx);
      drawMetaLabel(ctx, o.meta, bb.minX,bb.minY,bb.maxX,bb.maxY, style.color, idx, kindLabelForObj(o));
    } else if (o.kind === 'text'){
      const fs = o.fontSize ?? Math.max(14, (style.width ?? width) * 4);
      ctx.globalAlpha = style.opacity ?? opacity;
      ctx.fillStyle = style.color || color;
      ctx.font = `${fs}px "NetflixSans", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(String(o.text||''), o.x, o.y);
      if (o?.meta && (o.meta.g || o.meta.t || o.meta.sow || (Array.isArray(o.meta.sowList) && o.meta.sowList.length))){
        const bb = bboxOf(o, ctx);
        drawMetaLabel(ctx, o.meta, bb.minX,bb.minY,bb.maxX,bb.maxY, style.color, idx, kindLabelForObj(o));
      }
    }

    // ── Confidence ring: subtle glow for tracked shapes (not selected) ──────
    if (showGuides && (o.kind === 'rect' || o.kind === 'ellipse') && o.keyframes?.length > 1 && o.id !== selectedId) {
      const bb = bboxOf(o, ctx);
      const pad = 3;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      // Color: green = many keyframes (well-tracked), amber = few
      const kq = Math.min(1, (o.keyframes.length - 1) / 20); // 0=1kf, 1=21+kf
      const hue = Math.round(kq * 120); // 0=red,60=yellow,120=green
      ctx.strokeStyle = `hsla(${hue},85%,62%,0.35)`;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.strokeRect(bb.minX - pad, bb.minY - pad, bb.maxX - bb.minX + pad*2, bb.maxY - bb.minY + pad*2);
      ctx.restore();
    }

    if (showGuides && selectedId && o.id === selectedId){
      const bb = bboxOf(o, ctx);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.setLineDash([6,4]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(bb.minX, bb.minY, bb.maxX-bb.minX, bb.maxY-bb.minY);
      ctx.setLineDash([]);
      const hs = 6;
      const drawHandle = (x,y)=>{
        ctx.fillStyle = '#000';
        ctx.globalAlpha = 0.7;
        ctx.fillRect(x-hs, y-hs, hs*2, hs*2);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(x-hs, y-hs, hs*2, hs*2);
      };
      if (o.kind === 'rect' || o.kind === 'ellipse'){
        drawHandle(bb.minX, bb.minY);
        drawHandle(bb.maxX, bb.minY);
        drawHandle(bb.minX, bb.maxY);
        drawHandle(bb.maxX, bb.maxY);
      } else if (o.kind === 'arrow'){
        drawHandle(o.x1,o.y1);
        drawHandle(o.x2,o.y2);
      }
      ctx.restore();
    }

    ctx.restore();
  };

  let _labelOccupied = null; // active during render() pass for label collision avoidance

  // Track whether a render is already queued via rAF to deduplicate rapid calls.
  let _renderQueued = false;

  const render = (showGuides=true)=>{
    const ctx = ctx2d();
    if (!ctx) return;
    const cw = logicalW || canvas.width;
    const ch = logicalH || canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    try {
      const cf = currentFrameRef();
      _labelOccupied = [];
      objects.forEach((o, i) => {
        try {
          const fIn  = o.frameIn  ?? 0;
          const fOut = o.frameOut ?? 99999;
          if (cf < fIn || cf > fOut) return;
          const oi = (o.keyframes && o.keyframes.length > 0) ? _interpShape(o, cf) : o;
          renderObj(ctx, oi, showGuides, i);
        } catch { /* skip malformed shape, never leave canvas blank */ }
      });
      _labelOccupied = null;
      if (draft) { try { renderObj(ctx, draft, showGuides, objects.length); } catch {} }
      if (tlCanvas) { try { renderTimeline(); } catch {} }
      try {
        if (shapeNumEl) shapeNumEl.textContent = objects.length;
        if (shapeCountEl) shapeCountEl.classList.toggle('has-shapes', objects.length > 0);
      } catch {}
      try { _updateShapeInspector?.(); } catch {}
      try { _updateCtxStrip?.(); } catch {}
    } catch {
      // Ensure context state stack is clean even if something threw mid-draw
      try { ctx.restore(); } catch {}
    }
  };

  // Coalesced render: schedules a single render at the next animation frame,
  // deduplicating multiple synchronous calls (timeupdate + rAF overlap).
  const scheduleRender = () => {
    if (_renderQueued) return;
    _renderQueued = true;
    requestAnimationFrame(() => { _renderQueued = false; render(true); });
  };

  // ── Timeline strip ──────────────────────────────────────────────────────────
  const _tlColors = ['#ff4c4c','#ffd166','#2ecc71','#2ed8ff','#b06cff','#ff9f43','#ee5a24','#a29bfe'];
  let _tlDrag = null; // { shapeIdx, side: 'in'|'out' }
  const _tlThumbCache = new Map(); // shapeId → ImageBitmap

  const renderTimeline = () => {
    if (!tlCanvas || !video) return;
    const dpr = window.devicePixelRatio || 1;
    const W = tlCanvas.clientWidth || tlCanvas.offsetWidth || 400;
    const H = tlCanvas.clientHeight || tlCanvas.offsetHeight || 62;
    if (tlCanvas.width !== W * dpr || tlCanvas.height !== H * dpr) {
      tlCanvas.width  = W * dpr;
      tlCanvas.height = H * dpr;
    }
    const tlCtx = tlCanvas.getContext('2d');
    if (!tlCtx) return;
    tlCtx.save();
    tlCtx.scale(dpr, dpr);
    tlCtx.clearRect(0, 0, W, H);
    tlCtx.fillStyle = '#0b0b1a';
    tlCtx.fillRect(0, 0, W, H);

    const cb = getVideoClipBounds();
    const startF = cb.hasClipBounds ? cb.startFrame : 0;
    const endF   = cb.hasClipBounds ? cb.lastFrame  : Math.max(1, Math.floor((video.duration || 1) * videoFrameRate) - 1);
    const totalF = Math.max(1, endF - startF);

    // Zoom-aware visible range
    const visStartF = startF + _tlViewStart * totalF;
    const visEndF   = startF + _tlViewEnd   * totalF;
    const visF = Math.max(1, visEndF - visStartF);
    const frameToX = f => ((f - visStartF) / visF) * W;

    const RULER_H = 18, LANE_GAP = 2, LANE_TOP = RULER_H + 2;
    const LANE_H = Math.max(9, Math.min(22, Math.floor((H - RULER_H - 2 - 16) / Math.max(1, objects.length)) - LANE_GAP));

    // ── Ruler ────────────────────────────────────────────────────────────────
    tlCtx.fillStyle = '#0d0d22';
    tlCtx.fillRect(0, 0, W, RULER_H);

    // Nice tick interval
    const targetTicks = Math.max(4, Math.floor(W / 72));
    const INTERVALS = [1,2,5,10,15,24,25,30,48,50,60,120,150,300,600,1200,1800,3600,7200];
    const rawInterval = visF / targetTicks;
    const tickInterval = INTERVALS.find(n => n >= rawInterval) || INTERVALS[INTERVALS.length - 1];

    tlCtx.font = '8px monospace';
    tlCtx.textBaseline = 'middle';
    const firstTick = Math.ceil(visStartF / tickInterval) * tickInterval;
    for (let f = firstTick; f <= visEndF + 1; f += tickInterval) {
      const x = Math.round(frameToX(f));
      if (x < -2 || x > W + 2) continue;
      tlCtx.fillStyle = '#3a3a68';
      tlCtx.fillRect(x, RULER_H - 7, 1, 7);
      const relF = f - startF;
      const secs = relF / (videoFrameRate || 24);
      const mm = Math.floor(secs / 60), ss = Math.floor(secs % 60);
      const ff = Math.round((secs - Math.floor(secs)) * (videoFrameRate || 24)) % Math.max(1, Math.round(videoFrameRate || 24));
      const label = `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}:${String(ff).padStart(2,'0')}`;
      tlCtx.fillStyle = '#5858a0';
      tlCtx.fillText(label, x + 3, RULER_H / 2);
    }
    // Ruler separator
    tlCtx.fillStyle = '#1e1e40';
    tlCtx.fillRect(0, RULER_H - 1, W, 1);

    // ── Shape bars ───────────────────────────────────────────────────────────
    objects.forEach((o, i) => {
      const fIn  = o.frameIn  ?? startF;
      const fOut = o.frameOut ?? endF;
      const x1 = Math.max(-1, frameToX(fIn));
      const x2 = Math.min(W + 1, frameToX(fOut));
      if (x2 < 0 || x1 > W) return;
      const y   = LANE_TOP + i * (LANE_H + LANE_GAP);
      const isSelected = o.id === selectedId;
      const col = o.style?.color || _tlColors[i % _tlColors.length];
      // Bar fill
      tlCtx.fillStyle = col + (isSelected ? '99' : '44');
      tlCtx.fillRect(x1, y, Math.max(3, x2 - x1), LANE_H);
      // Handles
      tlCtx.fillStyle = col + (isSelected ? 'ff' : 'cc');
      tlCtx.fillRect(x1, y, 3, LANE_H);
      tlCtx.fillRect(Math.max(x1 + 3, x2 - 3), y, 3, LANE_H);
      // Per-shape thumbnail (captured at placement time)
      const thumb = _tlThumbCache.get(o.id);
      let thumbW = 0;
      if (thumb && LANE_H >= 13 && (x2 - x1) > 24) {
        thumbW = Math.min(Math.round(LANE_H * thumb.width / Math.max(1, thumb.height)), Math.floor(x2 - x1) - 8);
        try { tlCtx.drawImage(thumb, x1 + 4, y, thumbW, LANE_H); } catch {}
      }
      // Label (offset right of thumbnail if present)
      const labelX = x1 + (thumbW > 0 ? thumbW + 7 : 5);
      tlCtx.fillStyle = isSelected ? '#ffffffcc' : '#ffffff66';
      tlCtx.font = '7px monospace';
      tlCtx.textBaseline = 'middle';
      tlCtx.fillText(`${i + 1} ${o.kind}`, labelX, y + LANE_H / 2);
      // Keyframe diamonds
      if (o.keyframes) {
        o.keyframes.forEach(kf => {
          const kx = frameToX(kf.frame);
          if (kx < 0 || kx > W) return;
          const ky = y + LANE_H / 2;
          tlCtx.fillStyle = '#fff';
          tlCtx.beginPath();
          tlCtx.moveTo(kx, ky - 3); tlCtx.lineTo(kx + 3, ky);
          tlCtx.lineTo(kx, ky + 3); tlCtx.lineTo(kx - 3, ky);
          tlCtx.closePath(); tlCtx.fill();
        });
      }
    });

    // ── Scrub bar (full-clip progress track at bottom) ───────────────────────
    const SCRUB_H = 10, SCRUB_Y = H - SCRUB_H - 2, SCRUB_R = 5;
    // Track background
    tlCtx.fillStyle = 'rgba(255,255,255,0.08)';
    tlCtx.beginPath();
    tlCtx.roundRect(0, SCRUB_Y, W, SCRUB_H, SCRUB_R);
    tlCtx.fill();
    // Elapsed fill — always uses full clip range (not zoom)
    const cfRaw = currentFrameRef();
    const elapsedFrac = Math.max(0, Math.min(1, (cfRaw - startF) / totalF));
    const elapsedW = elapsedFrac * W;
    if (elapsedW > 0) {
      tlCtx.fillStyle = 'rgba(245,197,66,0.55)';
      tlCtx.beginPath();
      tlCtx.roundRect(0, SCRUB_Y, elapsedW, SCRUB_H, SCRUB_R);
      tlCtx.fill();
    }
    // Thumb
    const thumbX = Math.max(SCRUB_R, Math.min(W - SCRUB_R, elapsedFrac * W));
    tlCtx.fillStyle = '#fff';
    tlCtx.shadowColor = 'rgba(0,0,0,0.5)';
    tlCtx.shadowBlur = 4;
    tlCtx.beginPath();
    tlCtx.arc(thumbX, SCRUB_Y + SCRUB_H / 2, SCRUB_R, 0, Math.PI * 2);
    tlCtx.fill();
    tlCtx.shadowBlur = 0;

    // ── Zoom indicator strip (above scrub bar) ───────────────────────────────
    if (_tlViewStart > 0.001 || _tlViewEnd < 0.999) {
      const ZY = SCRUB_Y - 4;
      const zx1 = _tlViewStart * W, zx2 = _tlViewEnd * W;
      tlCtx.fillStyle = 'rgba(255,255,255,0.06)';
      tlCtx.fillRect(0, ZY, W, 2);
      tlCtx.fillStyle = 'rgba(245,197,66,0.55)';
      tlCtx.fillRect(zx1, ZY, Math.max(2, zx2 - zx1), 2);
    }

    // ── Playhead ─────────────────────────────────────────────────────────────
    const cf = cfRaw;
    const cx = Math.round(frameToX(cf));
    if (cx >= -5 && cx <= W + 5) {
      tlCtx.fillStyle = 'rgba(255,255,255,0.70)';
      tlCtx.fillRect(cx - 0.5, RULER_H, 1, SCRUB_Y - RULER_H - 2);
      // Playhead triangle
      tlCtx.fillStyle = '#fff';
      tlCtx.beginPath();
      tlCtx.moveTo(cx - 5, 0); tlCtx.lineTo(cx + 5, 0); tlCtx.lineTo(cx, 9);
      tlCtx.closePath(); tlCtx.fill();
    }

    tlCtx.restore();
  };

  if (tlCanvas) {
    const _tlHitTest = (x, y) => {
      const W = tlCanvas.clientWidth || 400;
      const cb = getVideoClipBounds();
      const startF = cb.hasClipBounds ? cb.startFrame : 0;
      const endF   = cb.hasClipBounds ? cb.lastFrame  : Math.max(1, Math.floor((video?.duration || 1) * videoFrameRate) - 1);
      const totalF = Math.max(1, endF - startF);
      const frameToX = f => ((f - startF) / totalF) * W;
      const LANE_H = 9, LANE_GAP = 2, LANE_TOP = 18, HIT = 6;
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        const laneY = LANE_TOP + i * (LANE_H + LANE_GAP);
        if (y < laneY || y > laneY + LANE_H) continue;
        const fIn  = o.frameIn  ?? startF;
        const fOut = o.frameOut ?? endF;
        if (Math.abs(x - frameToX(fIn))  <= HIT) return { shapeIdx: i, side: 'in' };
        if (Math.abs(x - frameToX(fOut)) <= HIT) return { shapeIdx: i, side: 'out' };
      }
      return null;
    };
    let _scrubDragging = false;
    const _tlSeekFromX = (x, W, useFullClip = false) => {
      const cb = getVideoClipBounds();
      const startF = cb.hasClipBounds ? cb.startFrame : 0;
      const endF   = cb.hasClipBounds ? cb.lastFrame  : Math.max(1, Math.floor((video?.duration || 1) * videoFrameRate) - 1);
      const totalF = Math.max(1, endF - startF);
      if (useFullClip) {
        // Scrub bar uses full-clip mapping
        return Math.round(startF + Math.max(0, Math.min(1, x / W)) * totalF);
      } else {
        // Ruler/lanes use zoomed view
        const visStartF = startF + _tlViewStart * totalF;
        const visEndF   = startF + _tlViewEnd   * totalF;
        return Math.round(visStartF + Math.max(0, Math.min(1, x / W)) * Math.max(1, visEndF - visStartF));
      }
    };
    tlCanvas.addEventListener('pointerdown', e => {
      const r = tlCanvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const H = r.height || 62;
      const SCRUB_Y = H - 12 - 2;
      // Click in scrub bar zone
      if (y >= SCRUB_Y - 4) {
        _scrubDragging = true;
        try { tlCanvas.setPointerCapture(e.pointerId); } catch {}
        const f = _tlSeekFromX(x, r.width || 400, true);
        const cb = getVideoClipBounds();
        setVideoFrame(Math.max(cb.startFrame ?? 0, Math.min(cb.lastFrame ?? 0, f)));
        return;
      }
      const hit = _tlHitTest(x, y);
      if (hit) {
        _tlDrag = hit;
        try { tlCanvas.setPointerCapture(e.pointerId); } catch {}
      } else {
        // Seek via ruler/lane area (zoom-aware)
        const f = _tlSeekFromX(x, r.width || 400, false);
        const cb = getVideoClipBounds();
        setVideoFrame(Math.max(cb.startFrame ?? 0, Math.min(cb.lastFrame ?? 0, f)));
      }
    });
    tlCanvas.addEventListener('pointermove', e => {
      if (_scrubDragging) {
        const r = tlCanvas.getBoundingClientRect();
        const f = _tlSeekFromX(e.clientX - r.left, r.width || 400, true);
        const cb = getVideoClipBounds();
        setVideoFrame(Math.max(cb.startFrame ?? 0, Math.min(cb.lastFrame ?? 0, f)));
        return;
      }
      if (!_tlDrag) return;
      const r = tlCanvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const W = tlCanvas.clientWidth || 400;
      const cb = getVideoClipBounds();
      const startF = cb.hasClipBounds ? cb.startFrame : 0;
      const endF   = cb.hasClipBounds ? cb.lastFrame  : Math.max(1, Math.floor((video?.duration || 1) * videoFrameRate) - 1);
      const f = Math.round(startF + (x / W) * Math.max(1, endF - startF));
      const o = objects[_tlDrag.shapeIdx];
      if (!o) return;
      const clamped = Math.max(startF, Math.min(endF, f));
      if (_tlDrag.side === 'in')  o.frameIn  = Math.min(clamped, o.frameOut ?? endF);
      else                         o.frameOut = Math.max(clamped, o.frameIn  ?? startF);
      render(true);
    });
    tlCanvas.addEventListener('pointerup', () => {
      if (_scrubDragging) { _scrubDragging = false; return; }
      if (_tlDrag) { pushState(); _tlDrag = null; }
    });
    tlCanvas.addEventListener('mousemove', e => {
      const r = tlCanvas.getBoundingClientRect();
      const y = e.clientY - r.top;
      const SCRUB_Y = (r.height || 62) - 12 - 2;
      if (y >= SCRUB_Y - 4) { tlCanvas.style.cursor = 'ew-resize'; return; }
      const hit = _tlHitTest(e.clientX - r.left, y);
      tlCanvas.style.cursor = hit ? 'col-resize' : 'pointer';
    });

    // Zoom (Cmd/Ctrl+scroll) and pan (plain scroll) on timeline
    tlCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = tlCanvas.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
      const span = _tlViewEnd - _tlViewStart;
      if (e.metaKey || e.ctrlKey) {
        // Zoom centered on cursor position
        const factor = e.deltaY < 0 ? 0.75 : 1.35;
        const newSpan = Math.max(0.01, Math.min(1.0, span * factor));
        const anchor = _tlViewStart + relX * span;
        _tlViewStart = Math.max(0, anchor - relX * newSpan);
        _tlViewEnd   = _tlViewStart + newSpan;
        if (_tlViewEnd > 1) { _tlViewEnd = 1; _tlViewStart = Math.max(0, 1 - newSpan); }
      } else {
        // Pan horizontally
        const delta = ((e.deltaX || e.deltaY * 0.15) / (r.width || 400)) * span * 3;
        _tlViewStart = Math.max(0, Math.min(1 - span, _tlViewStart + delta));
        _tlViewEnd   = _tlViewStart + span;
      }
      renderTimeline();
    }, { passive: false });
  }

  // ── Pixel template matching (object tracking) ───────────────────────────────
  const _makeOffscreen = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  };
  const _extractRegion = (vid, pos, size) => {
    const vw = vid.videoWidth || logicalW, vh = vid.videoHeight || logicalH;
    const scX = vw / logicalW, scY = vh / logicalH;
    const sx = Math.min(pos.x1, pos.x2) * scX, sy = Math.min(pos.y1, pos.y2) * scY;
    const sw = Math.abs(pos.x2 - pos.x1) * scX, sh = Math.abs(pos.y2 - pos.y1) * scY;
    const c = _makeOffscreen(size, size);
    c.getContext('2d').drawImage(vid, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, size, size);
    return c.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, size, size);
  };
  // Compute zero-mean normalized SAD between template and a patch in searchData.
  // Returns lower = better match. Normalising removes lighting/contrast sensitivity.
  const _znSAD = (tplData, searchData, size, S, dx, dy, step) => {
    let tSum = 0, pSum = 0, n = 0;
    for (let py = 0; py < size; py += step) {
      for (let px = 0; px < size; px += step) {
        const ti = (py * size + px) * 4;
        const si = ((dy + py) * S + (dx + px)) * 4;
        tSum += tplData[ti] + tplData[ti+1] + tplData[ti+2];
        pSum += searchData[si] + searchData[si+1] + searchData[si+2];
        n++;
      }
    }
    const tMean = tSum / (n * 3), pMean = pSum / (n * 3);
    let sad = 0;
    for (let py = 0; py < size; py += step) {
      for (let px = 0; px < size; px += step) {
        const ti = (py * size + px) * 4;
        const si = ((dy + py) * S + (dx + px)) * 4;
        sad += Math.abs((tplData[ti]   - tMean) - (searchData[si]   - pMean))
             + Math.abs((tplData[ti+1] - tMean) - (searchData[si+1] - pMean))
             + Math.abs((tplData[ti+2] - tMean) - (searchData[si+2] - pMean));
      }
    }
    return sad / Math.max(1, n * 3);  // normalize by pixel count → scale-independent score
  };

  // Single-channel ZN-SAD for edge maps (Float32Array row-major, stride = S).
  const _znSAD1 = (tpl1, img1, size, S, dx, dy, step) => {
    let tSum = 0, pSum = 0, n = 0;
    for (let py = 0; py < size; py += step) {
      for (let px = 0; px < size; px += step) {
        tSum += tpl1[py*size + px];
        pSum += img1[(dy+py)*S + (dx+px)];
        n++;
      }
    }
    const tMean = tSum / n, pMean = pSum / n;
    let sad = 0;
    for (let py = 0; py < size; py += step)
      for (let px = 0; px < size; px += step)
        sad += Math.abs((tpl1[py*size+px] - tMean) - (img1[(dy+py)*S+(dx+px)] - pMean));
    return sad / Math.max(1, n);
  };

  // Compute normalized Sobel edge-magnitude map from ImageData (returns Float32Array [0,255]).
  // Edge maps are invariant to additive+multiplicative illumination changes — matching on them
  // alongside pixel channels dramatically improves tracking through light changes and shadows.
  const _computeSobelEdges = (imgData, size) => {
    const d = imgData.data;
    const gray = new Float32Array(size * size);
    for (let i = 0; i < size*size; i++) gray[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
    const edges = new Float32Array(size * size);
    let maxE = 1;
    for (let y = 1; y < size-1; y++) {
      for (let x = 1; x < size-1; x++) {
        const i = y*size+x;
        const Gx = -gray[i-size-1]+gray[i-size+1] - 2*gray[i-1]+2*gray[i+1] - gray[i+size-1]+gray[i+size+1];
        const Gy = -gray[i-size-1]-2*gray[i-size]-gray[i-size+1] + gray[i+size-1]+2*gray[i+size]+gray[i+size+1];
        const mag = Math.sqrt(Gx*Gx + Gy*Gy);
        edges[i] = mag;
        if (mag > maxE) maxE = mag;
      }
    }
    for (let i = 0; i < edges.length; i++) edges[i] = (edges[i] / maxE) * 255;
    return edges;
  };

  // Search a region of the current video frame for the best match to tpl.
  // tplHist:  optional HSV histogram — penalises wrong-coloured regions.
  // tplEdges: optional Sobel edge map of the template — adds illumination-invariant
  //           edge channel to the score (weight 35%) to survive lighting changes/shadows.
  // Sub-pixel parabolic refinement is applied after the integer-grid fine pass for
  // ~0.3–0.5px extra localization accuracy at near-zero extra cost.
  // Returns { x1,y1,x2,y2, score } where score is normalized (lower = better).
  const _searchInRegion = (vid, tpl, searchPos, size, pad, tplHist = null, tplEdges = null) => {
    const vw = vid.videoWidth || logicalW, vh = vid.videoHeight || logicalH;
    const scX = vw / logicalW, scY = vh / logicalH;
    const px1 = Math.min(searchPos.x1, searchPos.x2), py1 = Math.min(searchPos.y1, searchPos.y2);
    const px2 = Math.max(searchPos.x1, searchPos.x2), py2 = Math.max(searchPos.y1, searchPos.y2);
    const shW = px2 - px1, shH = py2 - py1;
    const sx = Math.max(0, (px1 - pad) * scX), sy = Math.max(0, (py1 - pad) * scY);
    const sw = Math.min(vw - sx, (shW + pad * 2) * scX), sh = Math.min(vh - sy, (shH + pad * 2) * scY);
    const S = size * 2;
    const oc = _makeOffscreen(S, S);
    const octx = oc.getContext('2d');
    octx.drawImage(vid, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, S, S);
    const searchImgData = octx.getImageData(0, 0, S, S);
    const searchData = searchImgData.data;
    const tplData = tpl.data;

    // Pre-compute Sobel edge map for the search region (once per frame, not per candidate)
    let searchEdges = null;
    if (tplEdges) {
      const gray = new Float32Array(S * S);
      for (let i = 0; i < S*S; i++) gray[i] = 0.299*searchData[i*4] + 0.587*searchData[i*4+1] + 0.114*searchData[i*4+2];
      searchEdges = new Float32Array(S * S);
      let maxE = 1;
      for (let y = 1; y < S-1; y++) {
        for (let x = 1; x < S-1; x++) {
          const i = y*S+x;
          const Gx = -gray[i-S-1]+gray[i-S+1]-2*gray[i-1]+2*gray[i+1]-gray[i+S-1]+gray[i+S+1];
          const Gy = -gray[i-S-1]-2*gray[i-S]-gray[i-S+1]+gray[i+S-1]+2*gray[i+S]+gray[i+S+1];
          const mag = Math.sqrt(Gx*Gx+Gy*Gy);
          searchEdges[i] = mag;
          if (mag > maxE) maxE = mag;
        }
      }
      for (let i = 0; i < searchEdges.length; i++) searchEdges[i] = (searchEdges[i] / maxE) * 255;
    }

    const EDGE_W = 0.35;
    const scoreAt = (dx, dy, step) => {
      const px = _znSAD(tplData, searchData, size, S, dx, dy, step);
      if (!searchEdges) return px;
      const ed = _znSAD1(tplEdges, searchEdges, size, S, dx, dy, step);
      return (1 - EDGE_W) * px + EDGE_W * ed;
    };

    let bestScore = Infinity, secondScore = Infinity, bestDx = 0, bestDy = 0;
    // Coarse pass (step=2 inside znSAD)
    for (let dy = 0; dy <= size; dy += 3) {
      for (let dx = 0; dx <= size; dx += 3) {
        const s = scoreAt(dx, dy, 2);
        if (s < bestScore) {
          secondScore = bestScore;
          bestScore = s;
          bestDx = dx;
          bestDy = dy;
        } else if (s < secondScore) {
          secondScore = s;
        }
      }
    }
    // Fine pass (step=1) around best coarse hit
    for (let dy = Math.max(0, bestDy-4); dy <= Math.min(size, bestDy+4); dy++) {
      for (let dx = Math.max(0, bestDx-4); dx <= Math.min(size, bestDx+4); dx++) {
        const s = scoreAt(dx, dy, 1);
        if (s < bestScore) {
          secondScore = bestScore;
          bestScore = s;
          bestDx = dx;
          bestDy = dy;
        } else if (s < secondScore) {
          secondScore = s;
        }
      }
    }

    // Sub-pixel parabolic refinement: fit a parabola to the 3-point neighbourhood in
    // x and y around the integer best to get fractional-pixel accuracy (≈0.3–0.5px gain).
    let subDx = bestDx, subDy = bestDy;
    if (bestDx > 0 && bestDx < size) {
      const cm = scoreAt(bestDx-1, bestDy, 1), cp = scoreAt(bestDx+1, bestDy, 1);
      const denom = cm - 2*bestScore + cp;
      if (Math.abs(denom) > 1e-6) subDx = bestDx + Math.max(-0.5, Math.min(0.5, 0.5*(cm-cp)/denom));
    }
    if (bestDy > 0 && bestDy < size) {
      const cm = scoreAt(bestDx, bestDy-1, 1), cp = scoreAt(bestDx, bestDy+1, 1);
      const denom = cm - 2*bestScore + cp;
      if (Math.abs(denom) > 1e-6) subDy = bestDy + Math.max(-0.5, Math.min(0.5, 0.5*(cm-cp)/denom));
    }

    // HSV histogram penalty applied to final score
    if (tplHist) {
      const matchOc = _makeOffscreen(size, size);
      matchOc.getContext('2d').drawImage(oc, Math.round(bestDx), Math.round(bestDy), size, size, 0, 0, size, size);
      const matchHist = _buildHistogram(matchOc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, size, size));
      const sim = _histSimilarity(tplHist, matchHist);
      bestScore = bestScore * (2 - sim);
    }

    const searchW = shW + pad * 2, searchH = shH + pad * 2;
    const matchX = (px1 - pad) + (subDx / S) * searchW;
    const matchY = (py1 - pad) + (subDy / S) * searchH;
    const uniqueness = Number.isFinite(secondScore) && bestScore > 1e-6
      ? Math.max(0, (secondScore - bestScore) / bestScore)
      : 0;
    return {
      x1: matchX,
      y1: matchY,
      x2: matchX + shW,
      y2: matchY + shH,
      score: bestScore,
      secondScore,
      uniqueness,
    };
  };

  // Multi-scale template search: tries 3 scale factors and picks the best match.
  // Handles camera zoom-in/zoom-out without losing the subject.
  // tplHist and tplEdges are passed through to _searchInRegion.
  const _rectCenter = (rect)=>({
    x: ((Number(rect?.x1) || 0) + (Number(rect?.x2) || 0)) / 2,
    y: ((Number(rect?.y1) || 0) + (Number(rect?.y2) || 0)) / 2,
  });
  const _trackConfidence = ({ score = 99, uniqueness = 0, featureCount = 0, residual = 0, drift = 0 } = {})=>{
    const scoreNorm = Math.max(0, Math.min(1, 1 - ((Number(score) || 99) / 60)));
    const uniqNorm = Math.max(0, Math.min(1, Number(uniqueness) || 0));
    const featNorm = Math.max(0, Math.min(1, (Number(featureCount) || 0) / 6));
    const residualNorm = Math.max(0, Math.min(1, 1 - ((Number(residual) || 0) / 10)));
    const driftNorm = Math.max(0, Math.min(1, 1 - ((Number(drift) || 0) / 90)));
    return Math.max(0, Math.min(1,
      scoreNorm * 0.38 +
      uniqNorm * 0.20 +
      featNorm * 0.18 +
      residualNorm * 0.14 +
      driftNorm * 0.10
    ));
  };
  const _pickBestTrackCandidate = (candidates, predCenter = null)=>{
    let best = null;
    let bestRank = Infinity;
    for (const cand of (candidates || [])) {
      if (!cand) continue;
      const ctr = _rectCenter(cand);
      const drift = predCenter ? Math.hypot(ctr.x - predCenter.x, ctr.y - predCenter.y) : 0;
      const confidence = _trackConfidence({
        score: cand.score,
        uniqueness: cand.uniqueness,
        featureCount: cand.featureCount,
        residual: cand.avgResidual,
        drift,
      });
      const rank = (Number(cand.score) || 99)
        - confidence * 16
        - (Number(cand.uniqueness) || 0) * 6
        + drift * 0.04
        + ((cand.source === 'global-anchor' || cand.source === 'global-stable') ? 3.5 : 0);
      if (!best || rank < bestRank) {
        best = { ...cand, confidence, drift };
        bestRank = rank;
      }
    }
    return best;
  };
  const _templateSearch = (vid, tpl, prevPos, size, pad, tplHist = null, tplEdges = null, scales = null) => {
    // scales=null → default range; pass extended array for small objects
    const SCALES = scales || [0.78, 0.88, 1.0, 1.12, 1.22];
    let best = null;
    const cx = (prevPos.x1 + prevPos.x2) / 2, cy = (prevPos.y1 + prevPos.y2) / 2;
    const shW0 = prevPos.x2 - prevPos.x1, shH0 = prevPos.y2 - prevPos.y1;
    for (const sc of SCALES) {
      const shW = shW0 * sc, shH = shH0 * sc;
      const scaledPos = { x1: cx - shW/2, y1: cy - shH/2, x2: cx + shW/2, y2: cy + shH/2 };
      const r = _searchInRegion(vid, tpl, scaledPos, size, pad, tplHist, tplEdges);
      const drift = Math.hypot(_rectCenter(r).x - cx, _rectCenter(r).y - cy);
      const rank = r.score - (Number(r.uniqueness) || 0) * 6 + drift * 0.05 + Math.abs(sc - 1) * 2.5;
      if (!best || rank < best._rank) best = { ...r, scale: sc, _rank: rank };
    }
    return best;
  };
  const _blendRects = (fromRect, toRect, alpha = 0.5)=>{
    const t = Math.max(0, Math.min(1, Number(alpha) || 0));
    return {
      ...toRect,
      x1: (Number(fromRect?.x1) || 0) * (1 - t) + (Number(toRect?.x1) || 0) * t,
      y1: (Number(fromRect?.y1) || 0) * (1 - t) + (Number(toRect?.y1) || 0) * t,
      x2: (Number(fromRect?.x2) || 0) * (1 - t) + (Number(toRect?.x2) || 0) * t,
      y2: (Number(fromRect?.y2) || 0) * (1 - t) + (Number(toRect?.y2) || 0) * t,
      score: ((Number(fromRect?.score) || 0) + (Number(toRect?.score) || 0)) / 2,
      uniqueness: Math.max(Number(fromRect?.uniqueness) || 0, Number(toRect?.uniqueness) || 0),
    };
  };
  const _rectMotionMagnitude = (a, b)=>{
    if (!a || !b) return 0;
    const ca = _rectCenter(a);
    const cb = _rectCenter(b);
    return Math.hypot(ca.x - cb.x, ca.y - cb.y);
  };
  const _quantizeTrackedRect = (rect, step = 0.25)=>{
    const s = Math.max(0.01, Number(step) || 0.25);
    const q = (v)=> Math.round((Number(v) || 0) / s) * s;
    return {
      ...rect,
      x1: q(rect?.x1),
      y1: q(rect?.y1),
      x2: q(rect?.x2),
      y2: q(rect?.y2),
    };
  };
  const _stabilizeTrackedRect = ({ best, prevPos, speed = 0, confidence = 0, staticStreak = 0 })=>{
    if (!best || !prevPos) return { rect: best, staticStreak };
    const delta = _rectMotionMagnitude(best, prevPos);
    // Optical flow provides inherently smooth displacement from real pixel motion.
    // Don't suppress it with the static-lock logic — flow already handles jitter via
    // median aggregation. Only bypass when flow is confident AND motion is meaningful.
    const _isFlowSource = best.source === 'lk-flow' || best.source === 'lk-ctx'
                       || best.source === 'lk-scene' || best.source === 'raft-flow'
                       || best.source === 'particle';
    const _flowConfThr = (best.source === 'lk-ctx' || best.source === 'lk-scene') ? 0.25
                       : best.source === 'particle' ? 0.30 : 0.45;
    if (_isFlowSource && confidence >= _flowConfThr && delta >= 0.8) {
      return { rect: _quantizeTrackedRect(best, 0.25), staticStreak: 0 };
    }
    let next = best;
    let nextStatic = staticStreak;

    // When Kalman speed is near-zero and a static streak is established, the object is
    // genuinely not moving. The coarse template-search grid (~3 search-image pixels per step)
    // maps to ~8-14 logical pixels depending on search window size, so the "best" position
    // can alternate between neighbouring grid slots each frame even for a perfectly still
    // object. Treat any displacement within that grid-noise envelope as zero motion.
    const predictedStatic = speed < 0.8 && staticStreak >= 2;
    const extendedLock = (staticStreak >= 4 && delta <= 1.8) || (predictedStatic && delta <= 14);
    const nearStatic   = delta <= 1.3 && speed <= 1.3 && confidence >= 0.30;
    const microJitter  = delta <= 2.0 && speed <= 2.0 && confidence >= 0.40;
    const lowEnergy    = delta <= 2.8 && speed <= 2.4 && confidence >= 0.58;

    if (extendedLock || nearStatic) {
      nextStatic += 1;
      next = { ...best, x1: prevPos.x1, y1: prevPos.y1, x2: prevPos.x2, y2: prevPos.y2 };
    } else if (microJitter) {
      nextStatic += 1;
      // The longer the streak, the harder we hold — avoids cumulative oscillation
      const holdAlpha = nextStatic >= 5 ? 0.05 : nextStatic >= 3 ? 0.08 : 0.16;
      next = _blendRects(prevPos, best, holdAlpha);
    } else if (lowEnergy) {
      nextStatic = Math.max(0, nextStatic - 1);
      const smoothAlpha = delta <= 1.5 ? 0.28 : 0.42;
      next = _blendRects(prevPos, best, smoothAlpha);
    } else {
      nextStatic = 0;
      if (delta <= 4.5 && confidence >= 0.42) {
        const smoothAlpha = delta <= 2.5 ? 0.58 : 0.74;
        next = _blendRects(prevPos, best, smoothAlpha);
      }
    }

    return { rect: _quantizeTrackedRect(next, nextStatic >= 2 ? 0.2 : 0.25), staticStreak: nextStatic };
  };
  const _rectIou = (a, b)=>{
    if (!a || !b) return 0;
    const ax1 = Math.min(Number(a.x1) || 0, Number(a.x2) || 0);
    const ay1 = Math.min(Number(a.y1) || 0, Number(a.y2) || 0);
    const ax2 = Math.max(Number(a.x1) || 0, Number(a.x2) || 0);
    const ay2 = Math.max(Number(a.y1) || 0, Number(a.y2) || 0);
    const bx1 = Math.min(Number(b.x1) || 0, Number(b.x2) || 0);
    const by1 = Math.min(Number(b.y1) || 0, Number(b.y2) || 0);
    const bx2 = Math.max(Number(b.x1) || 0, Number(b.x2) || 0);
    const by2 = Math.max(Number(b.y1) || 0, Number(b.y2) || 0);
    const ix1 = Math.max(ax1, bx1);
    const iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
    const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
  };
  const _shouldEmitTrackKeyframe = ({
    candidate,
    committed,
    width = 0,
    height = 0,
    confidence = 0,
    staticStreak = 0,
  } = {})=>{
    if (!candidate || !committed) return true;
    const delta = _rectMotionMagnitude(candidate, committed);
    const iou = _rectIou(candidate, committed);
    const baseTol = Math.max(0.9, Math.min(4.5, Math.min(Math.max(1, width), Math.max(1, height)) * 0.028));
    const relaxedTol = baseTol + Math.min(2.2, Math.max(0, staticStreak - 1) * 0.28);
    if (confidence >= 0.84 && delta <= relaxedTol * 1.25 && iou >= 0.95) return false;
    if (confidence >= 0.72 && delta <= relaxedTol && iou >= 0.92) return false;
    if (confidence >= 0.58 && delta <= Math.max(0.8, relaxedTol * 0.72) && iou >= 0.96) return false;
    return true;
  };
  const _runTrackSmoothPass = (samples, width = 0, height = 0, reverse = false)=>{
    const seq = reverse ? samples.slice().reverse() : samples.slice();
    if (!seq.length) return [];
    const baseTol = Math.max(1.0, Math.min(3.6, Math.min(Math.max(1, width), Math.max(1, height)) * 0.026));
    const out = [];
    let prevRect = { ...seq[0].rect };
    let staticCount = 0;
    out.push({ frame: seq[0].frame, rect: _quantizeTrackedRect(prevRect, 0.2) });
    for (let i = 1; i < seq.length; i++) {
      const cur = seq[i];
      const delta = _rectMotionMagnitude(cur.rect, prevRect);
      let nextRect = cur.rect;
      if (delta <= baseTol) {
        staticCount += 1;
        nextRect = { ...prevRect };
      } else {
        staticCount = 0;
        const alpha = delta <= baseTol * 2.2 ? 0.16
          : delta <= baseTol * 4.5 ? 0.28
          : delta <= baseTol * 8 ? 0.48
          : 0.72;
        nextRect = _blendRects(prevRect, cur.rect, alpha);
      }
      nextRect = _quantizeTrackedRect(nextRect, staticCount >= 2 ? 0.15 : 0.2);
      out.push({ frame: cur.frame, rect: nextRect });
      prevRect = nextRect;
    }
    return reverse ? out.reverse() : out;
  };
  const _mergeTrackSmoothPasses = (forward, backward)=>{
    if (!Array.isArray(forward) || !forward.length) return [];
    return forward.map((sample, idx)=>{
      const paired = backward?.[idx]?.rect || sample.rect;
      return {
        frame: sample.frame,
        rect: _quantizeTrackedRect(_blendRects(sample.rect, paired, 0.5), 0.2),
      };
    });
  };
  const _sampleCenter = (sample)=> _rectCenter(sample?.rect || sample);
  const _sampleLineError = (sample, start, end)=>{
    const p = _sampleCenter(sample);
    const a = _sampleCenter(start);
    const b = _sampleCenter(end);
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 1e-6) {
      t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const projX = a.x + abx * t;
    const projY = a.y + aby * t;
    return Math.hypot(p.x - projX, p.y - projY);
  };
  const _rdpTrackSamples = (samples, epsilon = 1.1)=>{
    if (!Array.isArray(samples) || samples.length <= 2) return (samples || []).slice();
    const keep = new Set([0, samples.length - 1]);
    const walk = (startIdx, endIdx)=>{
      if (endIdx <= startIdx + 1) return;
      let maxErr = -1;
      let maxIdx = -1;
      for (let i = startIdx + 1; i < endIdx; i++) {
        const err = _sampleLineError(samples[i], samples[startIdx], samples[endIdx]);
        if (err > maxErr) { maxErr = err; maxIdx = i; }
      }
      if (maxErr > epsilon && maxIdx > startIdx && maxIdx < endIdx) {
        keep.add(maxIdx);
        walk(startIdx, maxIdx);
        walk(maxIdx, endIdx);
      }
    };
    walk(0, samples.length - 1);
    return samples.filter((_, idx)=> keep.has(idx));
  };
  const _compactTrackSamples = (samples, width = 0, height = 0)=>{
    if (!Array.isArray(samples) || !samples.length) return [];
    const tol = Math.max(0.8, Math.min(3.4, Math.min(Math.max(1, width), Math.max(1, height)) * 0.022));
    const out = [samples[0]];
    for (let i = 1; i < samples.length; i++) {
      const cur = samples[i];
      const last = out[out.length - 1];
      const delta = _rectMotionMagnitude(cur.rect, last.rect);
      const iou = _rectIou(cur.rect, last.rect);
      if (delta <= tol && iou >= 0.97) continue;
      out.push(cur);
    }
    return out;
  };
  const _buildTrackedKeyframesFromSamples = ({ samples, usesOffsetTrack = false, startCx = 0, startCy = 0, width = 0, height = 0 } = {})=>{
    if (!Array.isArray(samples) || !samples.length) return [];
    const forward = _runTrackSmoothPass(samples, width, height, false);
    const backward = _runTrackSmoothPass(samples, width, height, true);
    const merged = _mergeTrackSmoothPasses(forward, backward);
    const simplified = _rdpTrackSamples(merged, Math.max(0.6, Math.min(1.6, Math.min(Math.max(1, width), Math.max(1, height)) * 0.013)));
    const compacted = _compactTrackSamples(simplified, width, height);
    if (usesOffsetTrack) {
      return compacted.map(sample => {
        const ctr = _rectCenter(sample.rect);
        return {
          frame: sample.frame,
          tx: ctr.x - startCx,
          ty: ctr.y - startCy,
        };
      });
    }
    return compacted.map(sample => ({
      frame: sample.frame,
      x1: sample.rect.x1,
      y1: sample.rect.y1,
      x2: sample.rect.x2,
      y2: sample.rect.y2,
    }));
  };
  // Blend two ImageData arrays: alpha% new + (1-alpha)% old
  const _blendTemplate = (oldTpl, newTpl, alpha) => {
    const out = new ImageData(oldTpl.width, oldTpl.height);
    const a = Math.max(0, Math.min(1, alpha));
    for (let i = 0; i < oldTpl.data.length; i++) {
      out.data[i] = Math.round(oldTpl.data[i] * (1 - a) + newTpl.data[i] * a);
    }
    return out;
  };

  // ── Kalman Filter (constant-velocity 2D) ────────────────────────────────────
  // Tracks center position [x,y] with velocity [vx,vy].
  // Provides smoother predictions than a rolling average and handles measurement
  // noise + brief occlusion without amplifying drift.
  const _makeKalman = () => ({
    x: 0, y: 0, vx: 0, vy: 0,
    px: 4, py: 4, pvx: 4, pvy: 4,   // state covariances (diagonal P)
    Q: 0.3,   // process noise — lower = holds position steadier for static objects
    R: 3.0,   // measurement noise — tune higher if SAD matches are noisy
    initialized: false,
  });
  const _kalmanPredict = (kf) => {
    kf.x  += kf.vx;  kf.y  += kf.vy;
    kf.px += kf.pvx + kf.Q;  kf.py += kf.pvy + kf.Q;
    kf.pvx += kf.Q;  kf.pvy += kf.Q;
    return { x: kf.x, y: kf.y };
  };
  const _kalmanUpdate = (kf, mx, my) => {
    if (!kf.initialized) {
      kf.x = mx; kf.y = my; kf.initialized = true;
      return { x: mx, y: my };
    }
    const Kx = kf.px / (kf.px + kf.R),  Ky = kf.py  / (kf.py  + kf.R);
    const Kvx= kf.pvx/(kf.pvx+ kf.R),  Kvy= kf.pvy /(kf.pvy + kf.R);
    const dx = mx - kf.x, dy = my - kf.y;
    kf.vx += Kvx * dx;  kf.vy += Kvy * dy;
    kf.x  += Kx  * dx;  kf.y  += Ky  * dy;
    kf.px *= (1 - Kx);  kf.py  *= (1 - Ky);
    kf.pvx*= (1 - Kvx); kf.pvy *= (1 - Kvy);
    return { x: kf.x, y: kf.y };
  };

  // ── HSV Color Histogram Backprojection ───────────────────────────────────────
  // Builds a compact 16×8 HS histogram of a region.
  // Bhattacharyya similarity [0–1]: 1 = identical colour distribution, 0 = no overlap.
  // Used to penalise matches in wrong-coloured regions (prevents tracker latching
  // onto similarly-textured but differently-coloured backgrounds).
  const _buildHistogram = (imgData) => {
    const H_BINS = 16, S_BINS = 8;
    const hist = new Float32Array(H_BINS * S_BINS);
    const d = imgData.data;
    let count = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i+1] / 255, b = d[i+2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
      if (max < 0.08) continue;          // skip near-black (unreliable hue)
      const s = max === 0 ? 0 : delta / max;
      let h = 0;
      if (delta > 0) {
        if (max === r)      h = (g - b) / delta + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / delta + 2;
        else                h = (r - g) / delta + 4;
        h /= 6;
      }
      const hb = Math.min(H_BINS - 1, h * H_BINS | 0);
      const sb = Math.min(S_BINS - 1, s * S_BINS | 0);
      hist[hb * S_BINS + sb]++;
      count++;
    }
    if (count > 0) for (let i = 0; i < hist.length; i++) hist[i] /= count;
    return hist;
  };
  const _histSimilarity = (h1, h2) => {
    let bc = 0;
    for (let i = 0; i < h1.length; i++) bc += Math.sqrt(h1[i] * h2[i]);
    return Math.min(1, bc); // Bhattacharyya coefficient
  };
  const _median = (arr)=>{
    const vals = (arr || []).filter(Number.isFinite).slice().sort((a,b)=>a-b);
    if (!vals.length) return 0;
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  };
  const _solve3x3 = (m, v)=>{
    if (!Array.isArray(m) || m.length !== 3 || !Array.isArray(v) || v.length !== 3) return null;
    const a = m.map((row, i)=> [Number(row[0]) || 0, Number(row[1]) || 0, Number(row[2]) || 0, Number(v[i]) || 0]);
    for (let col = 0; col < 3; col++) {
      let pivot = col;
      for (let row = col + 1; row < 3; row++) {
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      }
      if (Math.abs(a[pivot][col]) < 1e-8) return null;
      if (pivot !== col) {
        const tmp = a[col];
        a[col] = a[pivot];
        a[pivot] = tmp;
      }
      const div = a[col][col];
      for (let j = col; j < 4; j++) a[col][j] /= div;
      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const factor = a[row][col];
        if (!factor) continue;
        for (let j = col; j < 4; j++) a[row][j] -= factor * a[col][j];
      }
    }
    return [a[0][3], a[1][3], a[2][3]];
  };
  const _solveWeightedPlane = (samples)=>{
    const rows = (samples || []).filter(s =>
      Number.isFinite(s?.u) &&
      Number.isFinite(s?.v) &&
      Number.isFinite(s?.y)
    );
    if (rows.length < 3) return null;
    let m00 = 0, m01 = 0, m02 = 0;
    let m11 = 0, m12 = 0, m22 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    rows.forEach(sample => {
      const u = Number(sample.u) || 0;
      const v = Number(sample.v) || 0;
      const y = Number(sample.y) || 0;
      const w = Math.max(0.001, Number(sample.w) || 1);
      m00 += w;
      m01 += w * u;
      m02 += w * v;
      m11 += w * u * u;
      m12 += w * u * v;
      m22 += w * v * v;
      b0 += w * y;
      b1 += w * u * y;
      b2 += w * v * y;
    });
    return _solve3x3(
      [
        [m00, m01, m02],
        [m01, m11, m12],
        [m02, m12, m22],
      ],
      [b0, b1, b2]
    );
  };
  const _identityFeatureModel = ()=> ({ a: 1, b: 0, c: 0, d: 1 });
  const _isFiniteFeatureModel = (model)=>{
    if (!model || typeof model !== 'object') return false;
    return ['a', 'b', 'c', 'd'].every(k => Number.isFinite(Number(model[k])));
  };
  const _applyFeatureModel = (model, dx, dy)=>{
    const safe = _isFiniteFeatureModel(model) ? model : _identityFeatureModel();
    return {
      x: safe.a * dx + safe.b * dy,
      y: safe.c * dx + safe.d * dy,
    };
  };
  const _invertFeatureModel = (model)=>{
    if (!_isFiniteFeatureModel(model)) return null;
    const det = model.a * model.d - model.b * model.c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return null;
    return {
      a:  model.d / det,
      b: -model.b / det,
      c: -model.c / det,
      d:  model.a / det,
    };
  };
  const _blendFeatureModel = (prevModel, nextModel, alpha = 0.28)=>{
    const prev = _isFiniteFeatureModel(prevModel) ? prevModel : _identityFeatureModel();
    const next = _isFiniteFeatureModel(nextModel) ? nextModel : prev;
    const t = Math.max(0, Math.min(1, Number(alpha) || 0));
    return {
      a: prev.a * (1 - t) + next.a * t,
      b: prev.b * (1 - t) + next.b * t,
      c: prev.c * (1 - t) + next.c * t,
      d: prev.d * (1 - t) + next.d * t,
    };
  };
  const _fitFeatureMotionModel = (matches)=>{
    let usable = (matches || []).filter(m =>
      m &&
      Number.isFinite(m.cx) &&
      Number.isFinite(m.cy) &&
      Number.isFinite(m.feature?.baseDx ?? m.feature?.dx) &&
      Number.isFinite(m.feature?.baseDy ?? m.feature?.dy)
    );
    if (usable.length < 3) return null;
    let model = null;
    let residuals = [];
    for (let iter = 0; iter < 3; iter++) {
      const planeX = _solveWeightedPlane(usable.map(m => ({
        u: Number(m.feature?.baseDx ?? m.feature?.dx) || 0,
        v: Number(m.feature?.baseDy ?? m.feature?.dy) || 0,
        y: m.cx,
        w: 1 / Math.max(4, Number(m.score) || 24),
      })));
      const planeY = _solveWeightedPlane(usable.map(m => ({
        u: Number(m.feature?.baseDx ?? m.feature?.dx) || 0,
        v: Number(m.feature?.baseDy ?? m.feature?.dy) || 0,
        y: m.cy,
        w: 1 / Math.max(4, Number(m.score) || 24),
      })));
      if (!planeX || !planeY) break;
      model = {
        tx: planeX[0],
        ty: planeY[0],
        a: planeX[1],
        b: planeX[2],
        c: planeY[1],
        d: planeY[2],
      };
      const det = model.a * model.d - model.b * model.c;
      const axisX = Math.hypot(model.a, model.c);
      const axisY = Math.hypot(model.b, model.d);
      if (!Number.isFinite(det) || Math.abs(det) < 0.08 || axisX < 0.35 || axisX > 2.8 || axisY < 0.35 || axisY > 2.8) {
        model = null;
        break;
      }
      residuals = usable.map(m => {
        const baseDx = Number(m.feature?.baseDx ?? m.feature?.dx) || 0;
        const baseDy = Number(m.feature?.baseDy ?? m.feature?.dy) || 0;
        const px = model.tx + model.a * baseDx + model.b * baseDy;
        const py = model.ty + model.c * baseDx + model.d * baseDy;
        return {
          match: m,
          err: Math.hypot(px - m.cx, py - m.cy),
        };
      });
      const medErr = _median(residuals.map(r => r.err));
      const errLimit = Math.max(2.6, medErr * 2.25, 5.4);
      const refined = residuals
        .filter(r => r.err <= errLimit && (Number(r.match?.score) || 99) <= 48)
        .map(r => r.match);
      if (refined.length === usable.length || refined.length < 3) break;
      usable = refined;
    }
    if (!model || usable.length < 3) return null;
    const avgResidual = residuals.length
      ? residuals.reduce((acc, r)=> acc + r.err, 0) / residuals.length
      : 99;
    const avgScore = usable.reduce((acc, m)=> acc + (Number(m.score) || 36), 0) / Math.max(1, usable.length);
    return {
      centerX: model.tx,
      centerY: model.ty,
      score: avgScore + avgResidual * 1.8,
      avgResidual,
      count: usable.length,
      matches: usable,
      model: { a: model.a, b: model.b, c: model.c, d: model.d },
    };
  };
  const _extractPatchAt = (vid, cx, cy, size)=>{
    const vw = vid.videoWidth || logicalW, vh = vid.videoHeight || logicalH;
    const scX = vw / logicalW, scY = vh / logicalH;
    const half = size / 2;
    const sx = (cx - half) * scX;
    const sy = (cy - half) * scY;
    const sw = size * scX;
    const sh = size * scY;
    const oc = _makeOffscreen(size, size);
    oc.getContext('2d').drawImage(vid, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, size, size);
    return oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, size, size);
  };
  const _patchTextureScore = (imgData, size)=>{
    const d = imgData?.data;
    if (!d) return 0;
    let score = 0;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = (y * size + x) * 4;
        const lum  = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        const lumR = 0.299*d[i+4] + 0.587*d[i+5] + 0.114*d[i+6];
        const lumD = 0.299*d[i+size*4] + 0.587*d[i+size*4+1] + 0.114*d[i+size*4+2];
        score += Math.abs(lumR - lum) + Math.abs(lumD - lum);
      }
    }
    return score / Math.max(1, (size - 2) * (size - 2));
  };
  const _buildFeatureTrackers = (vid, shape)=>{
    const PATCH = 15;
    const MAX_FEATURES = 9;
    const MIN_SPACING = Math.max(10, Math.min(Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1)) / 4);
    const minX = Math.min(shape.x1, shape.x2), minY = Math.min(shape.y1, shape.y2);
    const maxX = Math.max(shape.x1, shape.x2), maxY = Math.max(shape.y1, shape.y2);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const cols = 5, rows = 4;
    const candidates = [];
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const px = minX + (gx + 0.5) * ((maxX - minX) / cols);
        const py = minY + (gy + 0.5) * ((maxY - minY) / rows);
        if (px - PATCH/2 < 0 || py - PATCH/2 < 0 || px + PATCH/2 >= logicalW || py + PATCH/2 >= logicalH) continue;
        const tpl = _extractPatchAt(vid, px, py, PATCH);
        const texture = _patchTextureScore(tpl, PATCH);
        const dx = px - cx;
        const dy = py - cy;
        candidates.push({ id: genId(), cx: px, cy: py, dx, dy, baseDx: dx, baseDy: dy, tpl, texture, size: PATCH });
      }
    }
    candidates.sort((a,b)=> b.texture - a.texture);
    const picked = [];
    for (const cand of candidates) {
      if (cand.texture < 6) continue;
      const tooClose = picked.some(p => Math.hypot(p.dx - cand.dx, p.dy - cand.dy) < MIN_SPACING);
      if (tooClose) continue;
      picked.push(cand);
      if (picked.length >= MAX_FEATURES) break;
    }
    return picked;
  };
  const _refreshFeatureTrackers = (vid, box, prevFeatures, matches = [], motionModel = null)=>{
    const centerX = (box.x1 + box.x2) / 2;
    const centerY = (box.y1 + box.y2) / 2;
    const invModel = _invertFeatureModel(motionModel);
    const updated = [];
    const byId = new Map((matches || []).map(m => [m.feature?.id, m]));
    for (const ft of (prevFeatures || [])) {
      const match = byId.get(ft.id);
      if (!match) continue;
      const nextDx = match.cx - centerX;
      const nextDy = match.cy - centerY;
      const freshTpl = _extractPatchAt(vid, match.cx, match.cy, ft.size || 15);
      updated.push({
        ...ft,
        cx: match.cx,
        cy: match.cy,
        dx: ft.dx * 0.7 + nextDx * 0.3,
        dy: ft.dy * 0.7 + nextDy * 0.3,
        baseDx: Number.isFinite(ft.baseDx) ? ft.baseDx : ft.dx,
        baseDy: Number.isFinite(ft.baseDy) ? ft.baseDy : ft.dy,
        tpl: _blendTemplate(ft.tpl, freshTpl, 0.18),
        texture: Math.max(ft.texture || 0, _patchTextureScore(freshTpl, ft.size || 15)),
      });
    }
    const needMore = updated.length < 5;
    if (needMore) {
      const seeded = _buildFeatureTrackers(vid, box);
      seeded.forEach(cand => {
        const tooClose = updated.some(ft => Math.hypot(ft.dx - cand.dx, ft.dy - cand.dy) < Math.max(9, (ft.size || cand.size || 15) * 0.9));
        if (!tooClose) {
          const nextCand = { ...cand };
          if (invModel) {
            const canonical = _applyFeatureModel(invModel, cand.dx, cand.dy);
            nextCand.baseDx = canonical.x;
            nextCand.baseDy = canonical.y;
          }
          updated.push(nextCand);
        }
      });
    }
    updated.forEach(ft => {
      if (!Number.isFinite(ft.baseDx) || !Number.isFinite(ft.baseDy)) {
        if (invModel) {
          const canonical = _applyFeatureModel(invModel, ft.dx, ft.dy);
          ft.baseDx = canonical.x;
          ft.baseDy = canonical.y;
        } else {
          ft.baseDx = ft.dx;
          ft.baseDy = ft.dy;
        }
      }
    });
    updated.sort((a,b)=> (b.texture || 0) - (a.texture || 0));
    return updated.slice(0, 9);
  };
  const _matchFeaturePatch = (vid, feature, expectedCx, expectedCy, radius)=>{
    const size = feature.size || 15;
    const span = size + radius * 2;
    const vw = vid.videoWidth || logicalW, vh = vid.videoHeight || logicalH;
    const scX = vw / logicalW, scY = vh / logicalH;
    const startX = expectedCx - (size / 2 + radius);
    const startY = expectedCy - (size / 2 + radius);
    const oc = _makeOffscreen(span, span);
    oc.getContext('2d').drawImage(
      vid,
      startX * scX,
      startY * scY,
      Math.max(1, span * scX),
      Math.max(1, span * scY),
      0, 0, span, span
    );
    const search = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, span, span);
    const tpl = feature.tpl?.data;
    if (!tpl) return null;
    let bestScore = Infinity, bestDx = 0, bestDy = 0;
    for (let dy = 0; dy <= radius * 2; dy += 2) {
      for (let dx = 0; dx <= radius * 2; dx += 2) {
        const s = _znSAD(tpl, search.data, size, span, dx, dy, 1);
        if (s < bestScore) { bestScore = s; bestDx = dx; bestDy = dy; }
      }
    }
    for (let dy = Math.max(0, bestDy - 2); dy <= Math.min(radius * 2, bestDy + 2); dy++) {
      for (let dx = Math.max(0, bestDx - 2); dx <= Math.min(radius * 2, bestDx + 2); dx++) {
        const s = _znSAD(tpl, search.data, size, span, dx, dy, 1);
        if (s < bestScore) { bestScore = s; bestDx = dx; bestDy = dy; }
      }
    }
    const matchedCx = startX + bestDx + size / 2;
    const matchedCy = startY + bestDy + size / 2;
    return { cx: matchedCx, cy: matchedCy, score: bestScore };
  };
  const _trackFeatureGroup = (vid, features, predCenter, searchRadius, motionModel = null)=>{
    if (!Array.isArray(features) || features.length < 3) return null;
    const matches = [];
    for (const feature of features) {
      const baseDx = Number.isFinite(feature.baseDx) ? feature.baseDx : feature.dx;
      const baseDy = Number.isFinite(feature.baseDy) ? feature.baseDy : feature.dy;
      const projected = _isFiniteFeatureModel(motionModel)
        ? _applyFeatureModel(motionModel, baseDx, baseDy)
        : { x: feature.dx, y: feature.dy };
      const expectedCx = predCenter.x + projected.x;
      const expectedCy = predCenter.y + projected.y;
      const match = _matchFeaturePatch(vid, feature, expectedCx, expectedCy, searchRadius);
      if (!match) continue;
      matches.push({
        ...match,
        dx: match.cx - expectedCx,
        dy: match.cy - expectedCy,
        baseDx,
        baseDy,
        feature,
      });
    }
    if (matches.length < 3) return null;
    const planar = _fitFeatureMotionModel(matches);
    if (planar && planar.count >= 3) return planar;
    const medDx = _median(matches.map(m => m.dx));
    const medDy = _median(matches.map(m => m.dy));
    const usable = matches.filter(m =>
      Math.abs(m.dx - medDx) <= 4.8 &&
      Math.abs(m.dy - medDy) <= 4.8 &&
      m.score <= 42
    );
    if (usable.length < 2) return null;
    const finalDx = _median(usable.map(m => m.dx));
    const finalDy = _median(usable.map(m => m.dy));
    const avgScore = usable.reduce((acc, m)=> acc + m.score, 0) / Math.max(1, usable.length);
    return {
      centerX: predCenter.x + finalDx,
      centerY: predCenter.y + finalDy,
      score: avgScore,
      count: usable.length,
      matches: usable,
      model: motionModel || _identityFeatureModel(),
    };
  };

  const _tryTrackAssistReacquire = async ({ shape, predPos, frame, localBest, confThreshold, assistEvery = 6 })=>{
    const mode = String(trackCfg.mode || 'auto');
    const hint = _inferTrackingHint(shape);
    const wantsRemote = (mode === 'remote' || mode === 'auto') && _scopeAllowsRemote();
    const wantsDetect = (mode === 'detect' || mode === 'auto') && mode !== 'remote';
    const shouldAssist = mode === 'remote'
      || localBest.score > confThreshold
      || ((frame % Math.max(2, assistEvery || 6)) === 0 && !!hint && mode !== 'local');
    if (!shouldAssist) return null;

    if (wantsRemote) {
      const providers = await _discoverTrackSources();
      const scopedProviders = providers.filter(p => {
        const src = String(p.source || '').toLowerCase();
        if (trackCfg.scope === 'catalog') return src === 'github' || src === 'api' || src === 'window';
        if (trackCfg.scope === 'remote') return src !== 'local';
        return true;
      });
      for (const provider of scopedProviders) {
        const remote = await _remoteTrackReacquire({ shape, predPos, frame, provider, hint });
        if (remote) {
          remote.score = Math.min(Number(localBest?.score || 50), 18);
          return remote;
        }
      }
    }

    if (!wantsDetect || !_scopeAllowsLocal()) return null;
    let rects = [];
    try{
      if (hint === 'faces') rects = _detectFacesRects();
      else if (hint === 'text') rects = _detectTextRects();
      else if (hint === 'screens') rects = _detectScreensRects();
    }catch{}
    const detected = _pickNearestTrackedRect(rects, predPos);
    if (!detected) return null;
    detected.score = Math.min(Number(localBest?.score || 50), 20);
    return detected;
  };

  // ── Scene cut detection ───────────────────────────────────────────────────────
  // Compares mean-absolute-diff of downsampled luma between consecutive frames.
  // Returns { isCut, sample } — sample must be stored and passed back next frame.
  const _captureFrameSample = (vid) => {
    try {
      const W = 64, H = Math.max(1, Math.round(64 * (vid.videoHeight / Math.max(1, vid.videoWidth))));
      const oc = _makeOffscreen(W, H);
      oc.getContext('2d').drawImage(vid, 0, 0, W, H);
      return oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, W, H);
    } catch { return null; }
  };
  const _detectSceneCut = (vid, prevSample, threshold = 0.14) => {
    const curr = _captureFrameSample(vid);
    if (!prevSample || !curr) return { isCut: false, sample: curr };
    const n = curr.data.length / 4;
    let diff = 0;
    for (let i = 0; i < n; i++) {
      const lC = 0.299*curr.data[i*4] + 0.587*curr.data[i*4+1] + 0.114*curr.data[i*4+2];
      const lP = 0.299*prevSample.data[i*4] + 0.587*prevSample.data[i*4+1] + 0.114*prevSample.data[i*4+2];
      diff += Math.abs(lC - lP);
    }
    return { isCut: diff / (n * 255) > threshold, sample: curr };
  };

  // ── Pyramid Lucas-Kanade optical flow (pure JS, zero downloads) ─────────────
  // Coarse-to-fine (3-level pyramid) handles large inter-frame motions.
  // Forward-backward consistency rejects unreliable flow vectors.
  // Shi-Tomasi cornerness weighting prefers trackable over flat/featureless pixels.

  // Build Gaussian image pyramid (each level half the resolution of the previous)
  const _buildLkPyramid = (canvas, levels = 3) => {
    const pyr = [canvas];
    for (let i = 1; i < levels; i++) {
      const prev = pyr[i-1];
      const W = Math.max(8, Math.floor(prev.width/2)), H = Math.max(8, Math.floor(prev.height/2));
      const c = new OffscreenCanvas(W, H);
      c.getContext('2d').drawImage(prev, 0, 0, W, H);
      pyr.push(c);
    }
    return pyr;
  };

  // Single-point LK: returns (u,v) displacement + Shi-Tomasi cornerness weight
  const _lkFlowPoint = (prev, curr, px, py, W, H, winR = 5) => {
    let Ixx=0,Iyy=0,Ixy=0,Ixt=0,Iyt=0;
    const x=Math.round(px), y=Math.round(py);
    const luma=(d,cx,cy)=>{const i=(Math.max(0,Math.min(H-1,cy))*W+Math.max(0,Math.min(W-1,cx)))*4;return 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];};
    for(let wy=-winR;wy<=winR;wy++){
      for(let wx=-winR;wx<=winR;wx++){
        const nx=Math.max(0,Math.min(W-1,x+wx)), ny=Math.max(0,Math.min(H-1,y+wy));
        const Ix=(luma(prev,nx+1,ny)-luma(prev,nx-1,ny))*0.5;
        const Iy=(luma(prev,nx,ny+1)-luma(prev,nx,ny-1))*0.5;
        const It=luma(curr,nx,ny)-luma(prev,nx,ny);
        Ixx+=Ix*Ix;Iyy+=Iy*Iy;Ixy+=Ix*Iy;Ixt+=Ix*It;Iyt+=Iy*It;
      }
    }
    const det=Ixx*Iyy-Ixy*Ixy;
    if(Math.abs(det)<0.5) return null;
    const u=-(Iyy*Ixt-Ixy*Iyt)/det, v=-(Ixx*Iyt-Ixy*Ixt)/det;
    if(Math.hypot(u,v)>60) return null;
    // Shi-Tomasi: min eigenvalue of structure tensor = trackability score
    const tr=Ixx+Iyy, dsc=Math.sqrt(Math.max(0,(Ixx-Iyy)**2+4*Ixy*Ixy));
    return {u, v, cornerness: Math.max(0,(tr-dsc)*0.5)};
  };

  // Pyramid LK with forward-backward consistency + cornerness-weighted median
  // prevPyr / currPyr may be a raw canvas OR a pyramid array (built by _buildLkPyramid)
  const _lkFlowTrack = (prevPyr, currPyr, bbox, gridN = 6) => {
    if (!prevPyr || !currPyr) return null;
    try {
      const PP = Array.isArray(prevPyr) ? prevPyr : _buildLkPyramid(prevPyr, 3);
      const CP = Array.isArray(currPyr) ? currPyr : _buildLkPyramid(currPyr, 3);
      const srcW = PP[0].width, srcH = PP[0].height;
      // Cache ImageData once per pyramid level (avoid repeated reads)
      const PD = PP.map(c => c.getContext('2d',{willReadFrequently:true}).getImageData(0,0,c.width,c.height).data);
      const CD = CP.map(c => c.getContext('2d',{willReadFrequently:true}).getImageData(0,0,c.width,c.height).data);
      const med = arr => {
        const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2);
        return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
      };
      let accumDx=0, accumDy=0, finalPts=[];
      // Coarse → fine: each level refines the accumulated displacement
      for (let l=PP.length-1; l>=0; l--) {
        const W=PP[l].width, H=PP[l].height, scX=W/srcW, scY=H/srcH;
        const bw=Math.max(1,(bbox.x2-bbox.x1)*scX), bh=Math.max(1,(bbox.y2-bbox.y1)*scY);
        const bx1=bbox.x1*scX+accumDx*scX, by1=bbox.y1*scY+accumDy*scY;
        const pts=[];
        for(let gy=0;gy<gridN;gy++) for(let gx=0;gx<gridN;gx++) {
          const px=bx1+(bw*(gx+0.5))/gridN, py=by1+(bh*(gy+0.5))/gridN;
          const fwd=_lkFlowPoint(PD[l],CD[l],px,py,W,H);
          if(!fwd) continue;
          // Forward-backward consistency: flow back from destination should return to origin
          const bk=_lkFlowPoint(CD[l],PD[l],px+fwd.u,py+fwd.v,W,H);
          if(!bk || Math.hypot(fwd.u+bk.u,fwd.v+bk.v)>1.5) continue;
          pts.push({u:fwd.u/scX, v:fwd.v/scY, cornerness:fwd.cornerness});
        }
        if(!pts.length) continue;
        // Cornerness-weighted: keep top 65% most-trackable points
        pts.sort((a,b)=>b.cornerness-a.cornerness);
        const top = pts.slice(0, Math.max(4, Math.ceil(pts.length*0.65)));
        accumDx += med(top.map(p=>p.u));
        accumDy += med(top.map(p=>p.v));
        if (l===0) finalPts=top;
      }
      // ── Context-ring fallback for dark/featureless interiors ─────────────
      // When the bbox interior has no texture (det≈0 for all points), expand
      // to an outer ring around the bbox. Adjacent context moves with the object
      // — this is the only way to track a truly dark/uniform region.
      // Threshold 0.40: if fewer than 40% of grid points are valid, expand context.
      // Dark bbox edges may give 7-10 "valid" points but a biased displacement;
      // 40% threshold forces the more reliable outer ring in those cases.
      if (finalPts.length < Math.max(4, Math.ceil(gridN * gridN * 0.40))) {
        const l = 0; // finest level only — context ring doesn't need pyramid
        const W=PP[l].width, H=PP[l].height, scX=W/srcW, scY=H/srcH;
        const bwCtx=Math.max(1,(bbox.x2-bbox.x1)*scX*2.0), bhCtx=Math.max(1,(bbox.y2-bbox.y1)*scY*2.0);
        const bx1Ctx=(bbox.x1-(bbox.x2-bbox.x1)*0.5)*scX+accumDx*scX;
        const by1Ctx=(bbox.y1-(bbox.y2-bbox.y1)*0.5)*scY+accumDy*scY;
        const ctxPts=[];
        for(let gy=0;gy<gridN;gy++) for(let gx=0;gx<gridN;gx++){
          const px=bx1Ctx+(bwCtx*(gx+0.5))/gridN, py=by1Ctx+(bhCtx*(gy+0.5))/gridN;
          const fwd=_lkFlowPoint(PD[l],CD[l],px,py,W,H);
          if(!fwd) continue;
          const bk=_lkFlowPoint(CD[l],PD[l],px+fwd.u,py+fwd.v,W,H);
          if(!bk||Math.hypot(fwd.u+bk.u,fwd.v+bk.v)>1.5) continue;
          ctxPts.push({u:fwd.u/scX, v:fwd.v/scY, cornerness:fwd.cornerness});
        }
        if(ctxPts.length>=4){
          ctxPts.sort((a,b)=>b.cornerness-a.cornerness);
          const ctxTop=ctxPts.slice(0,Math.max(4,Math.ceil(ctxPts.length*0.65)));
          // Accumulate context-ring displacement on top of coarse pyramid levels
          accumDx += med(ctxTop.map(p=>p.u));
          accumDy += med(ctxTop.map(p=>p.v));
          finalPts = ctxTop.map(p => ({...p, isContext:true}));
        }
      }
      if (!finalPts.length) return null;
      const us=finalPts.map(p=>p.u), vs=finalPts.map(p=>p.v);
      const mu=us.reduce((a,b)=>a+b,0)/us.length, mv=vs.reduce((a,b)=>a+b,0)/vs.length;
      const variance=us.reduce((s,x)=>s+(x-mu)**2,0)/us.length+vs.reduce((s,x)=>s+(x-mv)**2,0)/vs.length;
      // Context-ring tracking: valid but slightly lower confidence (the ring may include background)
      const isCtxFallback = finalPts.some(p=>p.isContext);
      const confidenceRaw = Math.max(0,Math.min(1,1-variance/10))*Math.min(1,finalPts.length/(gridN*gridN*0.35));
      const confidence = isCtxFallback ? confidenceRaw * 0.78 : confidenceRaw;
      return {
        dx:accumDx, dy:accumDy,
        newBox:{x1:bbox.x1+accumDx,y1:bbox.y1+accumDy,x2:bbox.x2+accumDx,y2:bbox.y2+accumDy},
        confidence, pointCount:finalPts.length, source: isCtxFallback ? 'lk-ctx' : 'lk-flow',
      };
    } catch { return null; }
  };

  const _trackShape = async (shape) => {
    if (!video || _isTracking || !_isTrackableShape(shape)) return;
    _isTracking = true;
    _trackingAborted = false;
    updateTrackBtnState();
    _showAiToast('Preparing AI tracking…');

    const startFrame = currentFrameRef();
    const endFrame   = shape.frameOut ?? _getDefaultFrameOut();
    const visibleShape = (shape.keyframes && shape.keyframes.length > 0) ? _interpShape(shape, startFrame) : shape;
    const trackStartRect = _trackRectOf(visibleShape, ctx2d());
    const trackProfile = _buildTrackingProfile(shape, trackStartRect);
    const SIZE = trackProfile.templateSize;
    const startCx = (trackStartRect.x1 + trackStartRect.x2) / 2;
    const startCy = (trackStartRect.y1 + trackStartRect.y2) / 2;
    let lockedW = Math.max(1, Math.abs(trackStartRect.x2 - trackStartRect.x1));
    let lockedH = Math.max(1, Math.abs(trackStartRect.y2 - trackStartRect.y1));
    // Profile-driven search window: tune for dark, small, text, or screen targets.
    const BASE_PAD = trackProfile.basePad;
    const MAX_PAD  = trackProfile.maxPad;
    const usesOffsetTrack = visibleShape.kind !== 'rect' && visibleShape.kind !== 'ellipse';
    const _isSmall = trackProfile.small;
    const _trackScales = trackProfile.searchScales;
    const _basePadEff = BASE_PAD;
    _setTrackTelemetry(shape.id, {
      profileLabel: trackProfile.label,
      profileDesc: _describeTrackingProfile(trackProfile),
      engine: 'Preparing',
      confidence: 0,
      progress: 0,
    });
    _showAiToast(`Tracking profile: ${trackProfile.label}${trackProfile.preferFlow ? ' · flow-first' : trackProfile.preferFeature ? ' · feature-first' : ''}`);
    let _nano = null;
    let _camEst = null;
    let _pf = null;
    let _prevCamMotion = { dx: 0, dy: 0, scale: 1, confidence: 0 };

    try {
      shape.trackBase = _captureTrackBase(visibleShape);
      let tpl = _extractRegion(video, trackStartRect, SIZE);
      // ── Dark-region mode: when the bbox is near-black, template matching is useless
      // at the bbox scale. Switch to a larger context template that includes surrounding
      // texture — the only source of motion information for dark/uniform objects.
      const _tplLuma = (() => {
        const d = tpl.data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        return s / (d.length / 4);
      })();
      const _isDark = _tplLuma < 28; // avg luma < 28/255 = near-black interior
      if (_isDark) {
        // Expand template context by 60% on each side — include surrounding texture
        const dcx = (trackStartRect.x1 + trackStartRect.x2) / 2;
        const dcy = (trackStartRect.y1 + trackStartRect.y2) / 2;
        const dexp = 0.60;
        const darkCtxRect = {
          x1: dcx - lockedW * (0.5 + dexp), y1: dcy - lockedH * (0.5 + dexp),
          x2: dcx + lockedW * (0.5 + dexp), y2: dcy + lockedH * (0.5 + dexp),
        };
        const ctxTpl = _extractRegion(video, darkCtxRect, SIZE);
        const ctxLuma = (() => {
          const d2 = ctxTpl.data; let s2 = 0;
          for (let i = 0; i < d2.length; i += 4) s2 += 0.299*d2[i]+0.587*d2[i+1]+0.114*d2[i+2];
          return s2 / (d2.length / 4);
        })();
        // Only use context template if it has more information than the original
        if (ctxLuma > _tplLuma + 10) tpl = ctxTpl;
        _showAiToast('Dark region detected — using context tracking');
      }
      let anchorTpl = tpl;
      let stableTpl = tpl;
      let features = _buildFeatureTrackers(video, trackStartRect);
      let featureModel = _identityFeatureModel();
      // Sobel edge template: invariant to additive+multiplicative illumination changes.
      // Matched alongside pixel channels (35% weight) so tracking survives shadows and
      // exposure shifts that would confuse pure pixel-based matching.
      let tplEdges = _computeSobelEdges(tpl, SIZE);
      let anchorEdges = tplEdges.slice();
      let stableEdges = tplEdges.slice();
      // HSV histogram fingerprint to penalise wrong-coloured candidate regions.
      let tplHist = _buildHistogram(tpl);
      let anchorHist = tplHist.slice();
      let stableHist = tplHist.slice();
      shape.keyframes = usesOffsetTrack
        ? [{ frame: startFrame, tx: 0, ty: 0 }]
        : [{ frame: startFrame, x1: trackStartRect.x1, y1: trackStartRect.y1, x2: trackStartRect.x2, y2: trackStartRect.y2 }];
      const trackedSamples = [{ frame: startFrame, rect: { ...trackStartRect } }];
      let prevPos = { x1: trackStartRect.x1, y1: trackStartRect.y1, x2: trackStartRect.x2, y2: trackStartRect.y2 };
      let lastCommittedPos = { ...prevPos };
      let lastReliablePos = { ...prevPos };
      let lowConfidenceStreak = 0;
      let highConfidenceStreak = 0;
      let staticStreak = 0;
      // ── Occlusion state (research: "Occlusions" failure scenario) ────────────
      // When confidence stays very low for several frames the target is likely
      // hidden. Enter occluded state: continue Kalman prediction, freeze templates,
      // require anchor re-identification before resuming normal tracking.
      let occluded = false;
      let occludedFrames = 0;
      const MAX_OCCLUDED = 40; // give up after this many predicted frames

      // Kalman filter for centre-point prediction (constant-velocity model).
      const kf = _makeKalman();
      _kalmanUpdate(kf, startCx, startCy);

      // ── Pre-track: optionally tighten box with SAM (edge snap to actual object) ─
      // SAM gives NanoTrack a precise template — loose user-drawn boxes cause the
      // neural tracker to embed a lot of background, reducing match accuracy.
      // Only runs if SAM is already cached (< 50ms) to avoid blocking track start.
      let tightenedRect = { ...trackStartRect };
      if (trackCfg.mode !== 'local') {
        try {
          const { samClickSegment } = await import(chrome.runtime.getURL('scripts/smart/smartAnnoAI.js'));
          const fw = logicalW || video.videoWidth || 1;
          const fh = logicalH || video.videoHeight || 1;
          // Click the centre of the drawn box
          const clickNx = ((trackStartRect.x1 + trackStartRect.x2) / 2) / Math.max(1, fw);
          const clickNy = ((trackStartRect.y1 + trackStartRect.y2) / 2) / Math.max(1, fh);
          const samBox = await Promise.race([
            samClickSegment(video, clickNx, clickNy),
            new Promise(r => setTimeout(() => r(null), 3000)), // 3s timeout
          ]);
          if (samBox) {
            const sx1 = samBox.x1 * fw, sy1 = samBox.y1 * fh;
            const sx2 = samBox.x2 * fw, sy2 = samBox.y2 * fh;
            // Only use SAM result if it's tighter than the drawn box (not bigger)
            const drawnArea = (trackStartRect.x2 - trackStartRect.x1) * (trackStartRect.y2 - trackStartRect.y1);
            const samArea   = (sx2 - sx1) * (sy2 - sy1);
            if (samArea < drawnArea * 1.2 && samArea > drawnArea * 0.05) {
              tightenedRect = { x1: sx1, y1: sy1, x2: sx2, y2: sy2 };
              _showAiToast('SAM: object boundary detected — tracker initialized', true);
            }
          }
        } catch {}
      }
      // Update template and locked dimensions to tightened box
      const initRect  = tightenedRect;
      const initCx    = (initRect.x1 + initRect.x2) / 2;
      const initCy    = (initRect.y1 + initRect.y2) / 2;
      lockedW = Math.max(1, initRect.x2 - initRect.x1);
      lockedH = Math.max(1, initRect.y2 - initRect.y1);
      // Re-extract templates with tightened region
      tpl = _extractRegion(video, initRect, SIZE);
      anchorTpl = tpl; stableTpl = tpl;
      tplEdges = _computeSobelEdges(tpl, SIZE);
      anchorEdges = tplEdges.slice(); stableEdges = tplEdges.slice();
      tplHist = _buildHistogram(tpl);
      anchorHist = tplHist.slice(); stableHist = tplHist.slice();
      // Update Kalman with tightened initial position
      _kalmanUpdate(kf, initCx, initCy);
      prevPos = { ...initRect }; lastCommittedPos = { ...initRect }; lastReliablePos = { ...initRect };
      // Update the initial keyframe to match the (possibly SAM-tightened) box
      if (!usesOffsetTrack) {
        shape.keyframes = [{ frame: startFrame, x1: initRect.x1, y1: initRect.y1, x2: initRect.x2, y2: initRect.y2 }];
      }
      trackedSamples[0] = { frame: startFrame, rect: { ...initRect } };

      // ── NanoTrack neural tracker — AWAITED before loop starts ─────────────────
      // Previously fire-and-forget: _nano was null for first 1-3 seconds of tracking,
      // causing template matching to dominate early frames where it struggles most.
      // Now we await initialization so NanoTrack is ready from frame 1.
      if (trackCfg.mode !== 'local') {
        try {
          _showAiToast('Initialising neural tracker…');
          const { NanoTracker } = await import(chrome.runtime.getURL('scripts/smart/nanoTracker.js'));
          const nt = new NanoTracker();
          await nt.load((pct) => { if (pct > 0 && pct < 100) _showAiToast(`Neural tracker loading… ${pct}%`); });
          const fw = logicalW || video.videoWidth || 1;
          const fh = logicalH || video.videoHeight || 1;
          const fc = new OffscreenCanvas(fw, fh);
          fc.getContext('2d').drawImage(video, 0, 0, fw, fh);
          await nt.init(fc, initRect);  // use tightened box for template
          _nano = nt;
          _showAiToast('Neural tracker ready ✓', true);
        } catch(e) { _nano = null; }
      }

      // ── Camera motion estimator — AWAITED before loop starts ──────────────────
      // Previously async: camera correction was never applied to early frames.
      // RAFT models are cached after first use (< 50ms on subsequent runs).
      if (trackCfg.mode !== 'local') {
        try {
          const { CameraMotionEstimator } = await import(chrome.runtime.getURL('scripts/smart/track3D.js'));
          const fw = logicalW || video.videoWidth || 1;
          const fh = logicalH || video.videoHeight || 1;
          const fc = new OffscreenCanvas(fw, fh);
          fc.getContext('2d').drawImage(video, 0, 0, fw, fh);
          _camEst = new CameraMotionEstimator();
          await _camEst.init(fc);
        } catch { _camEst = null; }
      }

      // LK optical flow uses 320×180 downsampled pyramid — fast, no model download
      const LK_W = 320, LK_H = 180;
      const _captLkCanvas = () => {
        const c = new OffscreenCanvas(LK_W, LK_H);
        c.getContext('2d').drawImage(video, 0, 0, LK_W, LK_H);
        return c;
      };
      let _prevLkPyr = _buildLkPyramid(_captLkCanvas(), 3); // 3-level pyramid of start frame
      // Adaptive Kalman R — ring buffer of recent confidence; high uncertainty → trust measurements less
      const _confBuf = new Float32Array(8);
      let _confBufIdx = 0;

      // ── Particle Filter tracker — runs alongside LK/NanoTrack ──────────────
      // Observation: Sobel edge NCC — works for dark/featureless objects.
      // Motion: LK flow at each particle centre — no ONNX model needed.
      try {
        const { ParticleTracker } = await import(chrome.runtime.getURL('scripts/smart/particleTracker.js'));
        const fw = logicalW || video.videoWidth || 1;
        const fh = logicalH || video.videoHeight || 1;
        const pfCanvas = _captLkCanvas();
        const pfRgba = pfCanvas.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, LK_W, LK_H).data;
        const pfBox = {
          x1: trackStartRect.x1 * LK_W / fw, y1: trackStartRect.y1 * LK_H / fh,
          x2: trackStartRect.x2 * LK_W / fw, y2: trackStartRect.y2 * LK_H / fh,
        };
        _pf = new ParticleTracker(150);
        _pf.init(pfRgba, LK_W, LK_H, pfBox);
        _showAiToast('Particle tracker ready ✓', true);
      } catch { _pf = null; }

      // Semantic hint for ByteRecover occlusion recovery
      const _semanticHint = (() => {
        const h = _inferTrackingHint(shape);
        if (h === 'faces') return 'face';
        if (h === 'screens') return 'screen';
        return 'person';
      })();

      for (let f = startFrame + 1; f <= endFrame; f++) {
        if (_trackingAborted) break;

        video.currentTime = frameToMediaTime(f);
        await new Promise(r => {
          const onSeeked = () => { clearTimeout(t); r(); };
          const t = setTimeout(() => { video.removeEventListener('seeked', onSeeked); r(); }, 1200);
          video.addEventListener('seeked', onSeeked, { once: true });
        });
        if (_trackingAborted) break;

        // ── Camera motion compensation — run RAFT to measure camera acceleration ─
        // Camera acceleration = change in camera velocity between frames.
        // When constant (smooth pan): acceleration ≈ 0, no correction.
        // When abrupt (pan start/stop): acceleration ≠ 0, corrects search centre.
        let _camAccelX = 0, _camAccelY = 0;
        if (_camEst) {
          try {
            const fw = logicalW || video.videoWidth || 1;
            const fh = logicalH || video.videoHeight || 1;
            const fc = new OffscreenCanvas(fw, fh);
            fc.getContext('2d').drawImage(video, 0, 0, fw, fh);
            // Exclude current tracked region from background flow estimate
            const fgBox = { x1: lastReliablePos.x1, y1: lastReliablePos.y1,
                            x2: lastReliablePos.x2, y2: lastReliablePos.y2 };
            const camMotion = await _camEst.update(fc, [fgBox]);
            if (camMotion.confidence > 0.25) {
              // Delta of camera motion = camera acceleration this frame
              _camAccelX = camMotion.dx - _prevCamMotion.dx;
              _camAccelY = camMotion.dy - _prevCamMotion.dy;
              _prevCamMotion = camMotion;
            }
          } catch {}
        }

        // ── RAFT flow bbox tracking — PRIMARY for dark/featureless objects ────
        // trackBboxFlow samples a grid of points INSIDE the bbox from the RAFT
        // flow field already computed above. It works purely on pixel displacement,
        // not appearance — critical for dark subjects that defeat template matching.
        // Runs in <1ms after the RAFT inference above.
        let _flowTrackResult = null;
        if (_camEst?.lastFlow) {
          try {
            const { trackBboxFlow } = await import(chrome.runtime.getURL('scripts/smart/raftFlow.js'));
            const fw = logicalW || video.videoWidth || 1;
            const fh = logicalH || video.videoHeight || 1;
            _flowTrackResult = trackBboxFlow(
              _camEst.lastFlow,
              { x1: prevPos.x1, y1: prevPos.y1, x2: prevPos.x2, y2: prevPos.y2 },
              fw, fh,
              6   // 6×6 = 36 sample points
            );
          } catch {}
        }

        // ── Pyramid LK optical flow — zero downloads, works for dark objects ────
        // 3-level pyramid + forward-backward consistency + Shi-Tomasi weighting.
        // Falls back to context-ring (outer annular region) when interior is dark.
        // Falls back to scene-motion LK (whole-frame median) as last resort.
        let _lkResult = null;
        let _currLkPyr = null; // kept in scope for scene-LK reuse
        try {
          const fw = logicalW || video.videoWidth || 1;
          const fh = logicalH || video.videoHeight || 1;
          const currLkCanvas = _captLkCanvas();
          _currLkPyr = _buildLkPyramid(currLkCanvas, 3);
          const lkBox = {
            x1: prevPos.x1 * LK_W / fw, y1: prevPos.y1 * LK_H / fh,
            x2: prevPos.x2 * LK_W / fw, y2: prevPos.y2 * LK_H / fh,
          };
          const raw = _lkFlowTrack(_prevLkPyr, _currLkPyr, lkBox);
          if (raw) {
            const dxSrc = raw.dx * fw / LK_W, dySrc = raw.dy * fh / LK_H;
            _lkResult = {
              dx: dxSrc, dy: dySrc,
              newBox: { x1: prevPos.x1+dxSrc, y1: prevPos.y1+dySrc,
                        x2: prevPos.x2+dxSrc, y2: prevPos.y2+dySrc },
              confidence: raw.confidence,
              pointCount: raw.pointCount,
              source: raw.source || 'lk-flow',
            };
          }
          // ── Scene-motion LK fallback (dark objects only) ────────────────────
          // When even the context ring yields insufficient confidence, sample the
          // whole LK frame to estimate the dominant scene/camera motion and apply
          // it to the bbox. Ensures dark mattes follow camera pans correctly.
          if (_isDark && (!_lkResult || _lkResult.confidence < 0.28)) {
            const sceneBox = { x1: LK_W*0.05, y1: LK_H*0.05, x2: LK_W*0.95, y2: LK_H*0.95 };
            const sceneRaw = _lkFlowTrack(_prevLkPyr, _currLkPyr, sceneBox, 8);
            if (sceneRaw && sceneRaw.confidence >= 0.18) {
              const dxSrc2 = sceneRaw.dx*fw/LK_W, dySrc2 = sceneRaw.dy*fh/LK_H;
              _lkResult = {
                dx: dxSrc2, dy: dySrc2,
                newBox: { x1:prevPos.x1+dxSrc2, y1:prevPos.y1+dySrc2,
                          x2:prevPos.x2+dxSrc2, y2:prevPos.y2+dySrc2 },
                confidence: sceneRaw.confidence * 0.65,
                pointCount: sceneRaw.pointCount,
                source: 'lk-scene',
              };
            }
          }
          _prevLkPyr = _currLkPyr; // advance pyramid for next frame
        } catch {}

        // ── Particle Filter tracking — Sobel edge NCC observation ──────────
        // Runs at LK resolution (320×180). Reuses the already-captured LK canvas.
        let _pfResult = null;
        if (_pf?.isReady) {
          try {
            const fw = logicalW || video.videoWidth || 1;
            const fh = logicalH || video.videoHeight || 1;
            const pfCanvas = _currLkPyr?.[0] || _captLkCanvas();
            const pfRgba = pfCanvas.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, LK_W, LK_H).data;
            const r = _pf.track(pfRgba);
            if (r) {
              _pfResult = {
                x1: r.x1*fw/LK_W, y1: r.y1*fh/LK_H, x2: r.x2*fw/LK_W, y2: r.y2*fh/LK_H,
                confidence: r.confidence, cx: r.cx*fw/LK_W, cy: r.cy*fh/LK_H, source: 'particle',
              };
            }
          } catch {}
        }

        // ── Kalman prediction: estimate next centre based on current velocity ──
        const pred = _kalmanPredict(kf);
        // Apply camera acceleration correction to prevent search window from
        // drifting in the wrong direction when the camera suddenly changes speed.
        const corrX = pred.x + _camAccelX;
        const corrY = pred.y + _camAccelY;
        const searchCenter = {
          x1: corrX - lockedW / 2, y1: corrY - lockedH / 2,
          x2: corrX + lockedW / 2, y2: corrY + lockedH / 2,
        };
        const predCenter = { x: corrX, y: corrY };

        // ── Adaptive search window (wider when moving fast, tighter when static) ─
        // Smaller pad → fewer search-image pixels per logical pixel → coarser
        // grid jumps shrink proportionally, reducing static-object jitter.
        const speed = Math.hypot(kf.vx, kf.vy);
        // Small objects: use wider relative search (_basePadEff > BASE_PAD)
        const minPad = (speed < 0.8 && staticStreak >= 2) ? 14 : _basePadEff;
        // When NanoTrack is active, cap pad growth: neural tracker handles fast motion
        // so we don't need to balloon the template-match search region, which causes
        // the tracker to find background instead of the object.
        const streakPadScale = _nano?.isReady ? 5 : 10;  // halve inflation when neural active
        const pad = Math.min(
          minPad + Math.round(speed * 2) + lowConfidenceStreak * streakPadScale,
          MAX_PAD + 36
        );

        // ── Primary: multi-point feature tracking ─────────────────────────────
        let featureBest = null;
        if (_scopeAllowsLocal()) {
          featureBest = _trackFeatureGroup(
            video,
            features,
            pred,
            Math.min(42, Math.max(10, Math.round(pad * (lowConfidenceStreak > 0 ? 0.72 : 0.52)))),
            featureModel
          );
        }

        // ── Fallback: multi-cue template match ───────────────────────────────
        const CONF_THRESHOLD = 32;
        const templateCandidates = [];
        const dynamicLocal = _templateSearch(video, tpl, searchCenter, SIZE, pad, tplHist, tplEdges, _trackScales);
        if (dynamicLocal) templateCandidates.push({ ...dynamicLocal, source: 'dynamic-local' });
        const stableLocal = _templateSearch(video, stableTpl, searchCenter, SIZE, pad, stableHist, stableEdges, _trackScales);
        if (stableLocal) templateCandidates.push({ ...stableLocal, source: 'stable-local' });
        if (lowConfidenceStreak > 0) {
          const anchorLocal = _templateSearch(video, anchorTpl, searchCenter, SIZE, Math.min(pad + 18, MAX_PAD + 64), anchorHist, anchorEdges, _trackScales);
          if (anchorLocal) templateCandidates.push({ ...anchorLocal, source: 'anchor-local' });
        }
        if (lowConfidenceStreak > 1) {
          const globalPad = Math.min(Math.max(logicalW, logicalH) / 4 + lowConfidenceStreak * 22, 260);
          const stableGlobal = _templateSearch(video, stableTpl, lastReliablePos, SIZE, globalPad, stableHist, stableEdges, _trackScales);
          if (stableGlobal) templateCandidates.push({ ...stableGlobal, source: 'global-stable' });
          const anchorGlobal = _templateSearch(video, anchorTpl, lastReliablePos, SIZE, globalPad, anchorHist, anchorEdges, _trackScales);
          if (anchorGlobal) templateCandidates.push({ ...anchorGlobal, source: 'global-anchor' });
        }
        let best = _pickBestTrackCandidate(templateCandidates, predCenter) || dynamicLocal || stableLocal;

        // ── NanoTrack fusion: merge neural result with template candidates ────
        // ── NanoTrack fusion ─────────────────────────────────────────────────
        // Now initialized BEFORE the loop, so _nano is always ready from frame 1.
        // Score ≥ 0.50 → trust NanoTrack and reset confidence streak.
        // Score 0.35–0.50 → use as tiebreaker.
        // Score < 0.35 → NanoTrack returned null already (internal threshold).
        let _nanoConfidence = 0;
        if (_nano?.isReady) {
          try {
            const fw = logicalW || video.videoWidth || 1;
            const fh = logicalH || video.videoHeight || 1;
            const fc = new OffscreenCanvas(fw, fh);
            fc.getContext('2d').drawImage(video, 0, 0, fw, fh);
            const nr = await _nano.track(fc);
            if (nr && nr.score >= 0.35) {
              _nanoConfidence = nr.score;
              const nanoCandidate = {
                x1: nr.x1, y1: nr.y1, x2: nr.x2, y2: nr.y2,
                score:      nr.score >= 0.65 ? 4 : nr.score >= 0.50 ? 10 : 20,
                uniqueness: Math.min(2.0, nr.score * 2.5),
                source:     'nanotrack',
                confidence: nr.score,
                featureCount: 0,
              };
              if (nr.score >= 0.50) {
                // Neural tracker confident → use as primary regardless of template match
                best = _pickBestTrackCandidate([nanoCandidate, best], predCenter) || nanoCandidate;
                // NanoTrack confident = object found → prevent streak inflation
                if (lowConfidenceStreak > 0) lowConfidenceStreak = Math.max(0, lowConfidenceStreak - 2);
              } else {
                // Low-confidence neural hint → blend with template
                best = _pickBestTrackCandidate([nanoCandidate, best].filter(Boolean), predCenter) || nanoCandidate;
              }
            }
          } catch {}
        }

        if (featureBest && featureBest.count >= 3) {
          const featureRect = {
            x1: featureBest.centerX - lockedW / 2,
            y1: featureBest.centerY - lockedH / 2,
            x2: featureBest.centerX + lockedW / 2,
            y2: featureBest.centerY + lockedH / 2,
            score: Number(featureBest.score) || 99,
            uniqueness: Math.max(0, Math.min(1.6, (featureBest.count / 6) + (36 - (featureBest.avgResidual || 0)) / 50)),
            featureCount: featureBest.count,
            avgResidual: featureBest.avgResidual || 0,
            source: 'features',
          };
          best = _pickBestTrackCandidate([best, featureRect], predCenter) || featureRect;
        }
        if (!best) {
          best = { ...searchCenter, score: 99, uniqueness: 0, source: 'predict' };
        }

        // ── RAFT flow fusion: inject flow-based result ────────────────────────
        // Flow tracking works where template/neural matching fails (dark objects,
        // low-contrast, near-black subjects). It tracks pure displacement — if
        // ANYTHING is moving inside the bbox it will detect it.
        if (_flowTrackResult && _flowTrackResult.pointCount >= 4) {
          const fr = _flowTrackResult;
          const flowBox = fr.newBox;
          const flowCandidate = {
            x1: flowBox.x1, y1: flowBox.y1, x2: flowBox.x2, y2: flowBox.y2,
            // Map flow confidence (0-1) to template-match score scale (lower=better)
            score:       fr.confidence >= 0.70 ? 5 : fr.confidence >= 0.45 ? 12 : 22,
            uniqueness:  Math.min(2.0, fr.confidence * 2.0),
            source:      'raft-flow',
            confidence:  fr.confidence,
            featureCount: fr.pointCount,
          };
          const flowPrimaryThr = trackProfile.flowPrimaryThreshold;
          const flowSecondaryThr = Math.max(0.18, flowPrimaryThr - 0.20);
          if (fr.confidence >= flowPrimaryThr) {
            // High flow confidence: use as primary regardless of template match
            // This is the key fix for dark/featureless objects
            best = _pickBestTrackCandidate([flowCandidate, best], predCenter) || flowCandidate;
            if (lowConfidenceStreak > 0) lowConfidenceStreak = Math.max(0, lowConfidenceStreak - 2);
          } else if (fr.confidence >= flowSecondaryThr) {
            // Medium confidence: use as additional candidate
            best = _pickBestTrackCandidate([flowCandidate, best], predCenter) || best;
          }
          // Update Kalman with flow displacement for better next-frame prediction
          if (fr.confidence >= 0.45) {
            const kfCx = (flowBox.x1 + flowBox.x2) / 2;
            const kfCy = (flowBox.y1 + flowBox.y2) / 2;
            _kalmanUpdate(kf, kfCx, kfCy);
          }
        }

        // ── LK flow fusion (fallback when RAFT not available) ────────────────
        // LK runs on every frame with zero latency. For dark/low-contrast objects,
        // LK often gives a clean displacement when template matching scores 99.
        if (_lkResult && _lkResult.pointCount >= 4) {
          const lk = _lkResult;
          const lkCandidate = {
            x1: lk.newBox.x1, y1: lk.newBox.y1, x2: lk.newBox.x2, y2: lk.newBox.y2,
            score:        lk.confidence >= 0.70 ? 6 : lk.confidence >= 0.45 ? 14 : 24,
            uniqueness:   Math.min(2.0, lk.confidence * 2.0),
            source:       lk.source || 'lk-flow',
            confidence:   lk.confidence,
            featureCount: lk.pointCount,
          };
          // lk-ctx / lk-scene track surrounding context — lower activation threshold
          // since the confidence is dampened by 0.78 / 0.65 respectively.
          const lkPrimaryThr = (lk.source === 'lk-ctx' || lk.source === 'lk-scene')
            ? Math.min(trackProfile.lkPrimaryThreshold, 0.35)
            : trackProfile.lkPrimaryThreshold;
          const lkSecondaryThr = (lk.source === 'lk-ctx' || lk.source === 'lk-scene')
            ? Math.max(0.16, lkPrimaryThr - 0.12)
            : Math.max(0.22, lkPrimaryThr - 0.20);
          if (lk.confidence >= lkPrimaryThr) {
            best = _pickBestTrackCandidate([lkCandidate, best], predCenter) || lkCandidate;
            if (lowConfidenceStreak > 0) lowConfidenceStreak = Math.max(0, lowConfidenceStreak - 2);
          } else if (lk.confidence >= lkSecondaryThr) {
            best = _pickBestTrackCandidate([lkCandidate, best], predCenter) || best;
          }
          if (lk.confidence >= 0.40) {
            _kalmanUpdate(kf, (lk.newBox.x1+lk.newBox.x2)/2, (lk.newBox.y1+lk.newBox.y2)/2);
          }
        }

        // ── Particle Filter fusion ─────────────────────────────────────────
        // PF uses Sobel edge NCC — strong signal even for dark/featureless objects.
        // Weight: 150 particles × per-particle edge NCC observation.
        if (_pfResult && _pfResult.confidence >= 0.20) {
          const pf = _pfResult;
          const pfCandidate = {
            x1: pf.x1, y1: pf.y1, x2: pf.x2, y2: pf.y2,
            score:        pf.confidence >= 0.65 ? 5 : pf.confidence >= 0.40 ? 13 : 22,
            uniqueness:   Math.min(1.8, pf.confidence * 1.8),
            source:       'particle',
            confidence:   pf.confidence,
            featureCount: 0,
          };
          const pfPrimaryThr = trackProfile.particlePrimaryThreshold;
          const pfSecondaryThr = Math.max(0.18, pfPrimaryThr - 0.18);
          if (pf.confidence >= pfPrimaryThr) {
            best = _pickBestTrackCandidate([pfCandidate, best], predCenter) || pfCandidate;
            if (lowConfidenceStreak > 0) lowConfidenceStreak = Math.max(0, lowConfidenceStreak - 2);
          } else if (pf.confidence >= pfSecondaryThr) {
            best = _pickBestTrackCandidate([pfCandidate, best], predCenter) || best;
          }
          if (pf.confidence >= 0.35) _kalmanUpdate(kf, pf.cx, pf.cy);
        }

        // Confidence fallback: wide global search anchored on last confirmed position
        if (best.score > CONF_THRESHOLD) {
          const globalPad = Math.min(Math.max(logicalW, logicalH) / 4, 200);
          const globalBest = _templateSearch(video, tpl, lastReliablePos, SIZE, globalPad, tplHist, tplEdges, _trackScales);
          const improved = _pickBestTrackCandidate(
            [
              best,
              globalBest ? { ...globalBest, source: 'dynamic-global' } : null,
            ],
            predCenter
          );
          if (improved && improved !== best) {
            best = improved;
            kf.vx = 0; kf.vy = 0; kf.pvx = 4; kf.pvy = 4;
          }
        }

        if (String(trackCfg.mode || 'auto') !== 'local') {
          const assisted = await _tryTrackAssistReacquire({
            shape,
            predPos: searchCenter,
            frame: f,
            localBest: best,
            confThreshold: CONF_THRESHOLD,
            assistEvery: trackProfile.assistEvery,
          });
          if (assisted) best = assisted;
        }
        best = _lockTrackedBoxSize(best, lockedW, lockedH);
        const bestCenter = _rectCenter(best);
        // When NanoTrack is confident, raise the floor of bestConfidence so the
        // occlusion state machine and template update don't suppress neural evidence.
        const _nanoFloor = _nanoConfidence >= 0.65 ? 0.65 : _nanoConfidence >= 0.50 ? 0.55 : 0;
        // RAFT flow floor: if optical flow is confidently tracking, don't let template
        // failures push bestConfidence below the flow confidence — prevents false occlusion
        // on dark/featureless objects where template matching scores 99 (worst).
        const _flowFloor = (_flowTrackResult?.confidence ?? 0) >= 0.65 ? 0.65
                         : (_flowTrackResult?.confidence ?? 0) >= 0.50 ? 0.55 : 0;
        // LK flow floor: same logic but always available (no model download)
        // lk-scene / lk-ctx have lower raw confidence but represent real scene motion —
        // use a lower activation threshold so they still floor bestConfidence above the
        // occlusion entry point (< 0.22 for 3+ frames).
        const _lkConf    = _lkResult?.confidence ?? 0;
        const _lkFloor   = _lkConf >= 0.65 ? 0.65
                         : _lkConf >= 0.38 ? 0.55
                         : _lkConf >= 0.20 ? 0.38 : 0;
        // Particle filter floor: PF edge-NCC works for dark objects
        const _pfConf    = _pfResult?.confidence ?? 0;
        const _pfFloor   = _pfConf >= 0.60 ? 0.60
                         : _pfConf >= 0.40 ? 0.52
                         : _pfConf >= 0.22 ? 0.36 : 0;
        const bestConfidence = Math.max(
          _nanoFloor,
          _flowFloor,
          _lkFloor,
          _pfFloor,
          Number.isFinite(best.confidence)
            ? best.confidence
            : _trackConfidence({
                score: best.score,
                uniqueness: best.uniqueness,
                featureCount: best.featureCount,
                residual: best.avgResidual,
                drift: Math.hypot(bestCenter.x - predCenter.x, bestCenter.y - predCenter.y),
              })
        );
        if (bestConfidence < 0.34) {
          best = _lockTrackedBoxSize(_blendRects(searchCenter, best, 0.38), lockedW, lockedH);
        } else if (bestConfidence < 0.52) {
          best = _lockTrackedBoxSize(_blendRects(searchCenter, best, 0.62), lockedW, lockedH);
        }
        if (bestConfidence >= trackProfile.stableConfidence) {
          lastReliablePos = { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 };
          lowConfidenceStreak = 0;
          highConfidenceStreak++;
        } else {
          lowConfidenceStreak++;
          highConfidenceStreak = 0;
        }

        // Adaptive Kalman R: when tracking is uncertain, increase measurement noise weight
        // so the filter trusts its own prediction more than the noisy measurements.
        _confBuf[_confBufIdx++ % 8] = bestConfidence;
        const _avgConf = _confBuf.reduce((a,b)=>a+b,0) / 8;
        kf.R = _avgConf >= 0.65 ? 1.5 : _avgConf >= 0.45 ? 3.0 : _avgConf >= 0.30 ? 5.5 : 9.0;

        // ── Occlusion state machine ───────────────────────────────────────────
        // Entering occlusion: confidence persistently < 0.22 for 3+ frames
        if (!occluded && lowConfidenceStreak >= 3 && bestConfidence < trackProfile.occlusionEnterConfidence) {
          occluded = true;
          occludedFrames = 0;
          kf.R = 9.0; // trust prediction over bad measurements
        }
        if (occluded) {
          // Re-ID check: require anchor histogram similarity before resuming
          if (bestConfidence >= 0.52 && best.source !== 'predict') {
            try {
              const reIdRegion = _extractRegion(video, best, SIZE);
              const anchorSim = _histSimilarity(anchorHist, _buildHistogram(reIdRegion));
              if (anchorSim >= 0.60 && best.score < CONF_THRESHOLD - 4) {
                occluded = false; kf.R = 3.0; occludedFrames = 0;
                lowConfidenceStreak = 0;
              }
            } catch {}
          }
          if (occluded) {
            // If optical flow is still tracking confidently, the object is NOT truly occluded —
            // it's just dark/featureless (template + neural fail but flow detects motion).
            // Exit occlusion and trust the flow position rather than Kalman-predicting.
            // lk-ctx / lk-scene have lower raw confidence — use 0.28 as activation
            const _lkStillSees = (_lkResult?.confidence ?? 0) >= (
              (_lkResult?.source === 'lk-ctx' || _lkResult?.source === 'lk-scene') ? 0.28 : 0.45);
            const _pfStillSees = (_pfResult?.confidence ?? 0) >= 0.30;
            const _flowStillSees = _lkStillSees || _pfStillSees || (_flowTrackResult?.confidence ?? 0) >= 0.45;
            if (_flowStillSees) {
              occluded = false;
              occludedFrames = 0;
              kf.R = 3.0;
              lowConfidenceStreak = Math.max(0, lowConfidenceStreak - 3);
              // best already has the flow candidate from fusion above — keep it
            } else {
            // Pure Kalman prediction — don't drift to wrong object
            best = _lockTrackedBoxSize(
              { ...searchCenter, score: 60, uniqueness: 0, source: 'occluded-predict' },
              lockedW, lockedH
            );
            occludedFrames++;
            // ── ByteRecover: YOLO detection to find re-appeared target ────────
            // Activates every 4 frames during occlusion (not every frame — YOLO
            // takes ~150ms on WASM so we throttle it to avoid stalling scrubbing).
            if (occludedFrames % 4 === 0) {
              try {
                const { recoverTrack } = await import(chrome.runtime.getURL('scripts/smart/byteRecover.js'));
                const fw = logicalW || video.videoWidth || 1;
                const fh = logicalH || video.videoHeight || 1;
                const fc = new OffscreenCanvas(fw, fh);
                fc.getContext('2d').drawImage(video, 0, 0, fw, fh);
                const recovered = await recoverTrack(fc, lastReliablePos, _semanticHint,
                  (pct) => { if (pct < 100) _showAiToast(`Re-acquiring target… ${pct}%`); });
                if (recovered) {
                  // Target found! Snap tracker to recovered position
                  best = _lockTrackedBoxSize(
                    { ...recovered, score: 12, uniqueness: 1.2, source: 'byte-recover' },
                    Math.abs(recovered.x2 - recovered.x1),
                    Math.abs(recovered.y2 - recovered.y1),
                  );
                  lockedW = Math.abs(recovered.x2 - recovered.x1);
                  lockedH = Math.abs(recovered.y2 - recovered.y1);
                  lastReliablePos = { x1: recovered.x1, y1: recovered.y1, x2: recovered.x2, y2: recovered.y2 };
                  occluded = false; occludedFrames = 0; lowConfidenceStreak = 0;
                  kf.R = 3.0;
                  // Re-init NanoTracker on recovered position
                  if (_nano?.isReady) {
                    try { await _nano.init(fc, recovered); } catch {}
                  }
                  _showAiToast('Target re-acquired', true);
                }
              } catch {}
            }
            // Only declare target lost if ALL flow methods are also unreliable.
            // Dark objects can still be tracked by optical flow even when template/neural
            // matching fails — don't break the loop while any flow engine is confident.
            const _anyFlowActive = (_flowTrackResult?.confidence ?? 0) >= 0.40
                                || (_lkResult?.confidence ?? 0) >= (
                                    (_lkResult?.source === 'lk-ctx' || _lkResult?.source === 'lk-scene') ? 0.22 : 0.40)
                                || (_pfResult?.confidence ?? 0) >= 0.25;
            if (occluded && occludedFrames >= MAX_OCCLUDED && !_anyFlowActive) break;
            } // end else (not _flowStillSees)
          }
        }

        const stabilized = _stabilizeTrackedRect({
          best,
          prevPos,
          speed,
          confidence: bestConfidence,
          staticStreak,
        });
        best = _lockTrackedBoxSize(stabilized.rect, lockedW, lockedH);
        staticStreak = stabilized.staticStreak;
        if (bestConfidence >= trackProfile.stableConfidence || staticStreak >= 2) {
          lastReliablePos = { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 };
        }
        // Scale adaptation: best.scale is set by _templateSearch (0.85/1.0/1.15 winning scale)
        // Nudge lockedW/H 6% toward the winning scale each high-confidence frame so the
        // bounding box tracks zoom-in/zoom-out without abrupt jumps.
        if (best.scale && best.scale !== 1.0 && bestConfidence >= Math.max(0.56, trackProfile.stableConfidence - 0.02)) {
          const rate = bestConfidence >= 0.82 ? 0.10 : bestConfidence >= 0.72 ? 0.08 : 0.06;
          lockedW = Math.max(8, lockedW * (1 + rate * (best.scale - 1.0)));
          lockedH = Math.max(8, lockedH * (1 + rate * (best.scale - 1.0)));
          best = _lockTrackedBoxSize(best, lockedW, lockedH);
          if (bestConfidence >= trackProfile.stableConfidence) lastReliablePos = { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 };
        }
        trackedSamples.push({
          frame: f,
          rect: { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 },
        });

        const shouldEmitKeyframe = _shouldEmitTrackKeyframe({
          candidate: best,
          committed: lastCommittedPos,
          width: lockedW,
          height: lockedH,
          confidence: bestConfidence,
          staticStreak,
        });

        if (shouldEmitKeyframe) {
          if (usesOffsetTrack) {
            const bestCx = (best.x1 + best.x2) / 2;
            const bestCy = (best.y1 + best.y2) / 2;
            shape.keyframes.push({ frame: f, tx: bestCx - startCx, ty: bestCy - startCy });
          } else {
            shape.keyframes.push({ frame: f, x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 });
          }
          lastCommittedPos = { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 };
        }

        // ── Kalman correction ─────────────────────────────────────────────────
        _kalmanUpdate(kf, (best.x1 + best.x2) / 2, (best.y1 + best.y2) / 2);

        // ── Adaptive template update (every 4 frames when confident) ──────────
        // Blends pixels, edges, and histogram 80/20 to track slow appearance changes
        // (gradual lighting, subject turning) without drifting on single bad frames.
        if ((f - startFrame) % trackProfile.updateEvery === 0 && bestConfidence >= 0.50 && best.score < CONF_THRESHOLD + 4) {
          const fresh = _extractRegion(video, best, SIZE);
          tpl = _blendTemplate(tpl, fresh, trackProfile.updateBlend);
          const freshEdges = _computeSobelEdges(fresh, SIZE);
          for (let i = 0; i < tplEdges.length; i++) tplEdges[i] = tplEdges[i] * (1 - trackProfile.updateBlend) + freshEdges[i] * trackProfile.updateBlend;
          const freshHist = _buildHistogram(fresh);
          for (let i = 0; i < tplHist.length; i++) tplHist[i] = tplHist[i] * (1 - trackProfile.updateBlend) + freshHist[i] * trackProfile.updateBlend;
          if (bestConfidence >= 0.68) {
            stableTpl = _blendTemplate(stableTpl, fresh, 0.12);
            for (let i = 0; i < stableEdges.length; i++) stableEdges[i] = stableEdges[i] * 0.88 + freshEdges[i] * 0.12;
            for (let i = 0; i < stableHist.length; i++) stableHist[i] = stableHist[i] * 0.88 + freshHist[i] * 0.12;
          }
          if (bestConfidence >= 0.82 && highConfidenceStreak >= 5 && (f - startFrame) % 8 === 0) {
            anchorTpl = _blendTemplate(anchorTpl, fresh, 0.08);
            for (let i = 0; i < anchorEdges.length; i++) anchorEdges[i] = anchorEdges[i] * 0.92 + freshEdges[i] * 0.08;
            for (let i = 0; i < anchorHist.length; i++) anchorHist[i] = anchorHist[i] * 0.92 + freshHist[i] * 0.08;
          }
        }
        if (featureBest && (featureBest.count >= 3 || featureBest.score <= 28 || (f - startFrame) % 3 === 0 || bestConfidence < 0.5)) {
          if (_isFiniteFeatureModel(featureBest.model)) {
            const modelBlend = featureBest.count >= 5 && featureBest.score <= 30 ? 0.34 : (bestConfidence >= 0.58 ? 0.22 : 0.14);
            featureModel = _blendFeatureModel(featureModel, featureBest.model, modelBlend);
          }
          features = _refreshFeatureTrackers(video, best, features, featureBest.matches || [], featureModel);
        } else if ((f - startFrame) % 3 === 0 || bestConfidence < 0.42) {
          features = _refreshFeatureTrackers(video, best, features, [], featureModel);
        }

        prevPos = best;
        // Show which engine is driving + confidence level
        if ((f - startFrame) % 6 === 0) {
          const pct = Math.round((f - startFrame) / Math.max(1, endFrame - startFrame) * 100);
          const eng = best.source === 'nanotrack' ? '🧠 Neural'
                    : best.source === 'byte-recover' ? '🔍 Re-ID'
                    : best.source === 'raft-flow' ? '🌊 RAFT Flow'
                    : best.source === 'lk-flow' ? '⚡ LK Flow'
                    : best.source === 'lk-ctx'   ? '⚡ LK Context'
                    : best.source === 'lk-scene'  ? '🌐 Scene Motion'
                    : best.source === 'particle'  ? '🔵 Particle Filter'
                    : '📐 Template';
          const conf = Math.round(bestConfidence * 100);
          _setTrackTelemetry(shape.id, {
            engine: eng.replace(/^[^\s]+\s*/, ''),
            confidence: bestConfidence,
            progress: pct,
            profileLabel: trackProfile.label,
            profileDesc: _describeTrackingProfile(trackProfile),
            frame: f,
          });
          _showAiToast(`${eng} · ${conf}% · ${pct}% done`);
        }
        renderTimeline();
      }

      const smoothedTrackKeyframes = _buildTrackedKeyframesFromSamples({
        samples: trackedSamples,
        usesOffsetTrack,
        startCx,
        startCy,
        width: lockedW,
        height: lockedH,
      });
      if (smoothedTrackKeyframes.length) {
        shape.keyframes = smoothedTrackKeyframes;
        shape.trackInterpolation = 'hold';
      }
      _setTrackTelemetry(shape.id, {
        engine: 'Complete',
        confidence: 1,
        progress: 100,
        profileLabel: trackProfile.label,
        profileDesc: _describeTrackingProfile(trackProfile),
        frame: endFrame,
      });
    } catch(err) {
      // Partial result is fine — keep whatever keyframes were built
    } finally {
      // Dispose neural trackers to free WASM memory
      try { _nano?.dispose?.(); _nano = null; } catch {}
      try { _pf?.dispose?.(); _pf = null; } catch {}
      try { _camEst = null; } catch {}
      const wasAborted = _trackingAborted;
      _isTracking = false;
      _trackingAborted = false;
      video.currentTime = frameToMediaTime(startFrame);
      await new Promise(r => {
        const onS = () => { clearTimeout(t); r(); };
        const t = setTimeout(() => { video.removeEventListener('seeked', onS); r(); }, 1200);
        video.addEventListener('seeked', onS, { once: true });
      });
      pushState();
      render(true);
      updateTrackBtnState();
      if (wasAborted) {
        _setTrackTelemetry(shape.id, {
          engine: 'Stopped',
          confidence: 0,
          progress: 0,
          profileLabel: trackProfile.label,
          profileDesc: _describeTrackingProfile(trackProfile),
        });
      }
    }
  };

  // ── Track All ──────────────────────────────────────────────────────────────
  const _trackAll = async () => {
    if (_isTracking || !video) return;
    const targets = objects.filter(o => _isTrackableShape(o));
    if (!targets.length) return;
    const startFrame = currentFrameRef();
    _showAiToast(`Tracking ${targets.length} shape${targets.length > 1 ? 's' : ''}…`);
    for (let i = 0; i < targets.length; i++) {
      if (_trackingAborted) break;
      video.currentTime = frameToMediaTime(startFrame);
      await new Promise(r => {
        const onS = () => { clearTimeout(t); r(); };
        const t = setTimeout(() => { video.removeEventListener('seeked', onS); r(); }, 1200);
        video.addEventListener('seeked', onS, { once: true });
      });
      await _trackShape(targets[i]);
    }
    _showAiToast(`Track All complete — ${targets.length} shape${targets.length > 1 ? 's' : ''} tracked`, true);
  };

  // ── Parallel multi-shape tracking ──────────────────────────────────────────
  // Tracks all shapes in a single seek-per-frame loop instead of one full pass
  // per shape — reduces video seeks from N×M to just N for M shapes.
  const _trackAllParallel = async (shapesToTrack = null) => {
    if (_isTracking || !video) return;
    const targets = shapesToTrack
      ? shapesToTrack.filter(o => _isTrackableShape(o))
      : objects.filter(o => _isTrackableShape(o));
    if (!targets.length) return;
    _isTracking = true;
    _trackingAborted = false;
    updateTrackBtnState();

    const startFrame = currentFrameRef();
    const LK_W = 320, LK_H = 180;
    const _captLkCanvas = () => {
      const c = new OffscreenCanvas(LK_W, LK_H);
      c.getContext('2d').drawImage(video, 0, 0, LK_W, LK_H);
      return c;
    };
    let sharedStartLkPyr = null;
    try { sharedStartLkPyr = _buildLkPyramid(_captLkCanvas(), 3); } catch {}

    const states = [];
    for (const shape of targets) {
      const vis = shape.keyframes?.length ? _interpShape(shape, startFrame) : shape;
      const tr  = _trackRectOf(vis, ctx2d());
      const trackProfile = _buildTrackingProfile(shape, tr);
      const tplSize = trackProfile.templateSize;
      const lW  = Math.max(1, Math.abs(tr.x2 - tr.x1));
      const lH  = Math.max(1, Math.abs(tr.y2 - tr.y1));
      const uot = vis.kind !== 'rect' && vis.kind !== 'ellipse';
      const cx  = (tr.x1 + tr.x2) / 2, cy = (tr.y1 + tr.y2) / 2;
      shape.trackBase = _captureTrackBase(vis);
      let tpl = _extractRegion(video, tr, tplSize);
      if (trackProfile.dark || trackProfile.lowTexture) {
        const dcx = (tr.x1 + tr.x2) / 2;
        const dcy = (tr.y1 + tr.y2) / 2;
        const ctxRect = {
          x1: dcx - lW * 1.10, y1: dcy - lH * 1.10,
          x2: dcx + lW * 1.10, y2: dcy + lH * 1.10,
        };
        const ctxTpl = _extractRegion(video, ctxRect, tplSize);
        const tplStats = _sampleTrackingStats(video, tr, 36);
        const ctxStats = _sampleTrackingStats(video, ctxRect, 36);
        if ((ctxStats.edgeMean || 0) > (tplStats.edgeMean || 0) + 3 || (ctxStats.contrast || 0) > (tplStats.contrast || 0) + 5) {
          tpl = ctxTpl;
        }
      }
      const tplEdg  = _computeSobelEdges(tpl, tplSize);
      const tplHist = _buildHistogram(tpl);
      shape.keyframes = uot
        ? [{ frame: startFrame, tx: 0, ty: 0 }]
        : [{ frame: startFrame, x1: tr.x1, y1: tr.y1, x2: tr.x2, y2: tr.y2 }];
      const kf = _makeKalman(); _kalmanUpdate(kf, cx, cy);
      _setTrackTelemetry(shape.id, {
        profileLabel: trackProfile.label,
        profileDesc: _describeTrackingProfile(trackProfile),
        engine: 'Preparing',
        confidence: 0,
        progress: 0,
      });
      states.push({
        shape, endFrame: shape.frameOut ?? _getDefaultFrameOut(),
        lW, lH, uot, startCx: cx, startCy: cy,
        trackProfile, tplSize,
        basePad: trackProfile.basePad,
        maxPad: trackProfile.maxPad,
        searchScales: trackProfile.searchScales,
        tpl, anchorTpl: tpl, stableTpl: tpl,
        tplEdg, anchorEdg: tplEdg.slice(), stableEdg: tplEdg.slice(),
        tplHist, anchorHist: tplHist.slice(), stableHist: tplHist.slice(),
        features: _buildFeatureTrackers(video, tr),
        featureModel: _identityFeatureModel(),
        kf,
        prevLkPyr: sharedStartLkPyr,
        prevPos: { ...tr }, lastReliablePos: { ...tr }, lastCommittedPos: { ...tr },
        lowConf: 0, highConf: 0, staticStr: 0,
        samples: [{ frame: startFrame, rect: { ...tr } }],
        prevFrameSample: _captureFrameSample(video),
        cutDone: false,
      });
    }

    const maxEnd = Math.max(...states.map(s => s.endFrame));
    try {
      for (let f = startFrame + 1; f <= maxEnd; f++) {
        if (_trackingAborted) break;
        video.currentTime = frameToMediaTime(f);
        await new Promise(r => {
          const onSeeked = () => { clearTimeout(t); r(); };
          const t = setTimeout(() => { video.removeEventListener('seeked', onSeeked); r(); }, 1200);
          video.addEventListener('seeked', onSeeked, { once: true });
        });
        if (_trackingAborted) break;
        let currLkPyr = null;
        try { currLkPyr = _buildLkPyramid(_captLkCanvas(), 3); } catch {}
        _showAiToast(`Tracking ${targets.length} shape${targets.length > 1 ? 's' : ''}… ${Math.round((f - startFrame) / (maxEnd - startFrame) * 88)}%`);

        for (const st of states) {
          if (f > st.endFrame || st.cutDone) continue;
          // Scene cut detection — stop tracking this shape if a hard cut is found
          const cutResult = _detectSceneCut(video, st.prevFrameSample);
          st.prevFrameSample = cutResult.sample;
          if (cutResult.isCut) {
            st.cutDone = true;
            _setTrackTelemetry(st.shape.id, {
              engine: 'Cut',
              confidence: 0,
              progress: Math.round((f - startFrame) / Math.max(1, st.endFrame - startFrame) * 100),
              profileLabel: st.trackProfile.label,
              profileDesc: _describeTrackingProfile(st.trackProfile),
              frame: f,
            });
            continue;
          }
          const pred  = _kalmanPredict(st.kf);
          const sCtr  = { x1: pred.x - st.lW/2, y1: pred.y - st.lH/2, x2: pred.x + st.lW/2, y2: pred.y + st.lH/2 };
          const pCtr  = { x: pred.x, y: pred.y };
          const speed = Math.hypot(st.kf.vx, st.kf.vy);
          const minPad = (speed < 0.8 && st.staticStr >= 2) ? 14 : st.basePad;
          const padBoost = st.trackProfile.preferFlow ? 12 : 10;
          const speedBoost = st.trackProfile.preferFlow ? 2.4 : 2.0;
          const pad   = Math.min(minPad + Math.round(speed * speedBoost) + st.lowConf * padBoost, st.maxPad + 36);
          const THR   = st.trackProfile.preferFlow ? 34 : 32;

          let featureBest = null;
          if (_scopeAllowsLocal()) {
            featureBest = _trackFeatureGroup(video, st.features, pred,
              Math.min(42, Math.max(10, Math.round(pad * (st.lowConf > 0 ? 0.72 : 0.52)))), st.featureModel);
          }
          let lkResult = null;
          if (currLkPyr && st.prevLkPyr) {
            try {
              const fw = logicalW || video.videoWidth || 1;
              const fh = logicalH || video.videoHeight || 1;
              const lkBox = {
                x1: st.prevPos.x1 * LK_W / fw, y1: st.prevPos.y1 * LK_H / fh,
                x2: st.prevPos.x2 * LK_W / fw, y2: st.prevPos.y2 * LK_H / fh,
              };
              const raw = _lkFlowTrack(st.prevLkPyr, currLkPyr, lkBox);
              if (raw) {
                const dxSrc = raw.dx * fw / LK_W;
                const dySrc = raw.dy * fh / LK_H;
                lkResult = {
                  dx: dxSrc,
                  dy: dySrc,
                  newBox: {
                    x1: st.prevPos.x1 + dxSrc, y1: st.prevPos.y1 + dySrc,
                    x2: st.prevPos.x2 + dxSrc, y2: st.prevPos.y2 + dySrc,
                  },
                  confidence: raw.confidence,
                  pointCount: raw.pointCount,
                  source: raw.source || 'lk-flow',
                };
              }
              if (st.trackProfile.preferFlow && (!lkResult || lkResult.confidence < 0.28)) {
                const sceneBox = { x1: LK_W * 0.05, y1: LK_H * 0.05, x2: LK_W * 0.95, y2: LK_H * 0.95 };
                const sceneRaw = _lkFlowTrack(st.prevLkPyr, currLkPyr, sceneBox, 8);
                if (sceneRaw && sceneRaw.confidence >= 0.18) {
                  const dxSrc2 = sceneRaw.dx * fw / LK_W;
                  const dySrc2 = sceneRaw.dy * fh / LK_H;
                  lkResult = {
                    dx: dxSrc2,
                    dy: dySrc2,
                    newBox: {
                      x1: st.prevPos.x1 + dxSrc2, y1: st.prevPos.y1 + dySrc2,
                      x2: st.prevPos.x2 + dxSrc2, y2: st.prevPos.y2 + dySrc2,
                    },
                    confidence: sceneRaw.confidence * 0.65,
                    pointCount: sceneRaw.pointCount,
                    source: 'lk-scene',
                  };
                }
              }
            } catch {}
          }

          const cands = [];
          const d = _templateSearch(video, st.tpl,       sCtr, st.tplSize, pad, st.tplHist,    st.tplEdg, st.searchScales);
          const s = _templateSearch(video, st.stableTpl, sCtr, st.tplSize, pad, st.stableHist, st.stableEdg, st.searchScales);
          if (d) cands.push({ ...d, source: 'dynamic-local' });
          if (s) cands.push({ ...s, source: 'stable-local' });
          if (st.lowConf > 0) {
            const a = _templateSearch(video, st.anchorTpl, sCtr, st.tplSize, Math.min(pad + 18, st.maxPad + 64), st.anchorHist, st.anchorEdg, st.searchScales);
            if (a) cands.push({ ...a, source: 'anchor-local' });
          }
          if (st.lowConf > 1) {
            const gp = Math.min(Math.max(logicalW, logicalH)/4 + st.lowConf*22, 260);
            const sg = _templateSearch(video, st.stableTpl, st.lastReliablePos, st.tplSize, gp, st.stableHist, st.stableEdg, st.searchScales);
            const ag = _templateSearch(video, st.anchorTpl, st.lastReliablePos, st.tplSize, gp, st.anchorHist, st.anchorEdg, st.searchScales);
            if (sg) cands.push({ ...sg, source: 'global-stable' });
            if (ag) cands.push({ ...ag, source: 'global-anchor' });
          }
          let best = _pickBestTrackCandidate(cands, pCtr) || d || s;
          if (featureBest && featureBest.count >= 3) {
            const fR = {
              x1: featureBest.centerX - st.lW/2, y1: featureBest.centerY - st.lH/2,
              x2: featureBest.centerX + st.lW/2, y2: featureBest.centerY + st.lH/2,
              score: Number(featureBest.score)||99,
              uniqueness: Math.max(0, Math.min(1.6, featureBest.count/6+(36-(featureBest.avgResidual||0))/50)),
              featureCount: featureBest.count, avgResidual: featureBest.avgResidual||0, source: 'features',
            };
            best = _pickBestTrackCandidate([best, fR], pCtr) || fR;
          }
          if (lkResult && lkResult.pointCount >= 4) {
            const lkCandidate = {
              x1: lkResult.newBox.x1, y1: lkResult.newBox.y1, x2: lkResult.newBox.x2, y2: lkResult.newBox.y2,
              score: lkResult.confidence >= 0.70 ? 6 : lkResult.confidence >= 0.45 ? 14 : 24,
              uniqueness: Math.min(2.0, lkResult.confidence * 2.0),
              source: lkResult.source || 'lk-flow',
              confidence: lkResult.confidence,
              featureCount: lkResult.pointCount,
            };
            const lkPrimaryThr = (lkResult.source === 'lk-ctx' || lkResult.source === 'lk-scene')
              ? Math.min(st.trackProfile.lkPrimaryThreshold, 0.35)
              : st.trackProfile.lkPrimaryThreshold;
            const lkSecondaryThr = (lkResult.source === 'lk-ctx' || lkResult.source === 'lk-scene')
              ? Math.max(0.16, lkPrimaryThr - 0.12)
              : Math.max(0.22, lkPrimaryThr - 0.20);
            if (lkResult.confidence >= lkPrimaryThr) {
              best = _pickBestTrackCandidate([lkCandidate, best], pCtr) || lkCandidate;
              if (st.lowConf > 0) st.lowConf = Math.max(0, st.lowConf - 2);
            } else if (lkResult.confidence >= lkSecondaryThr) {
              best = _pickBestTrackCandidate([lkCandidate, best], pCtr) || best;
            }
            if (lkResult.confidence >= 0.40) {
              _kalmanUpdate(st.kf, (lkResult.newBox.x1 + lkResult.newBox.x2) / 2, (lkResult.newBox.y1 + lkResult.newBox.y2) / 2);
            }
          }
          if (!best) best = { ...sCtr, score: 99, uniqueness: 0, source: 'predict' };
          if (best.score > THR) {
            const gb = _templateSearch(video, st.tpl, st.lastReliablePos, st.tplSize, Math.min(Math.max(logicalW, logicalH)/4, 200), st.tplHist, st.tplEdg, st.searchScales);
            const improved = _pickBestTrackCandidate([best, gb ? { ...gb, source: 'dynamic-global' } : null], pCtr);
            if (improved && improved !== best) { best = improved; st.kf.vx = 0; st.kf.vy = 0; st.kf.pvx = 4; st.kf.pvy = 4; }
          }
          if (String(trackCfg.mode || 'auto') !== 'local') {
            const assisted = await _tryTrackAssistReacquire({
              shape: st.shape,
              predPos: sCtr,
              frame: f,
              localBest: best,
              confThreshold: THR,
              assistEvery: st.trackProfile.assistEvery,
            });
            if (assisted) best = assisted;
          }

          best = _lockTrackedBoxSize(best, st.lW, st.lH);
          const bCtr  = _rectCenter(best);
          const lkConf = lkResult?.confidence ?? 0;
          const lkFloor = lkConf >= 0.65 ? 0.65
            : lkConf >= 0.38 ? 0.55
            : lkConf >= 0.20 ? 0.38 : 0;
          const bConf = Math.max(
            lkFloor,
            Number.isFinite(best.confidence)
              ? best.confidence
              : _trackConfidence({ score: best.score, uniqueness: best.uniqueness, featureCount: best.featureCount,
                  residual: best.avgResidual, drift: Math.hypot(bCtr.x-pCtr.x, bCtr.y-pCtr.y) })
          );

          if (bConf < 0.34) best = _lockTrackedBoxSize(_blendRects(sCtr, best, 0.38), st.lW, st.lH);
          else if (bConf < 0.52) best = _lockTrackedBoxSize(_blendRects(sCtr, best, 0.62), st.lW, st.lH);

          if (bConf >= st.trackProfile.stableConfidence) { st.lastReliablePos = { ...best }; st.lowConf = 0; st.highConf++; }
          else               { st.lowConf++; st.highConf = 0; }

          const stab = _stabilizeTrackedRect({ best, prevPos: st.prevPos, speed, confidence: bConf, staticStreak: st.staticStr });
          best = _lockTrackedBoxSize(stab.rect, st.lW, st.lH);
          st.staticStr = stab.staticStreak;
          if (bConf >= st.trackProfile.stableConfidence || st.staticStr >= 2) st.lastReliablePos = { ...best };

          if (best.scale && best.scale !== 1.0 && bConf >= Math.max(0.56, st.trackProfile.stableConfidence - 0.02)) {
            const rate = bConf >= 0.82 ? 0.10 : bConf >= 0.72 ? 0.08 : 0.06;
            st.lW = Math.max(8, st.lW * (1 + rate * (best.scale - 1.0)));
            st.lH = Math.max(8, st.lH * (1 + rate * (best.scale - 1.0)));
            best = _lockTrackedBoxSize(best, st.lW, st.lH);
            if (bConf >= st.trackProfile.stableConfidence) st.lastReliablePos = { ...best };
          }

          st.samples.push({ frame: f, rect: { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 } });

          const emit = _shouldEmitTrackKeyframe({ candidate: best, committed: st.lastCommittedPos, width: st.lW, height: st.lH, confidence: bConf, staticStreak: st.staticStr });
          if (emit) {
            if (st.uot) {
              const bcx = (best.x1+best.x2)/2, bcy = (best.y1+best.y2)/2;
              st.shape.keyframes.push({ frame: f, tx: bcx - st.startCx, ty: bcy - st.startCy });
            } else {
              st.shape.keyframes.push({ frame: f, x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 });
            }
            st.lastCommittedPos = { ...best };
          }

          _kalmanUpdate(st.kf, (best.x1+best.x2)/2, (best.y1+best.y2)/2);

          if ((f - startFrame) % st.trackProfile.updateEvery === 0 && bConf >= 0.50 && best.score < THR + 4) {
            const fresh = _extractRegion(video, best, st.tplSize);
            st.tpl = _blendTemplate(st.tpl, fresh, st.trackProfile.updateBlend);
            const fEdg = _computeSobelEdges(fresh, st.tplSize);
            for (let i = 0; i < st.tplEdg.length; i++) st.tplEdg[i] = st.tplEdg[i] * (1 - st.trackProfile.updateBlend) + fEdg[i] * st.trackProfile.updateBlend;
            const fHist = _buildHistogram(fresh);
            for (let i = 0; i < st.tplHist.length; i++) st.tplHist[i] = st.tplHist[i] * (1 - st.trackProfile.updateBlend) + fHist[i] * st.trackProfile.updateBlend;
            if (bConf >= 0.68) {
              st.stableTpl = _blendTemplate(st.stableTpl, fresh, 0.12);
              for (let i = 0; i < st.stableEdg.length; i++) st.stableEdg[i] = st.stableEdg[i]*0.88 + fEdg[i]*0.12;
              for (let i = 0; i < st.stableHist.length; i++) st.stableHist[i] = st.stableHist[i]*0.88 + fHist[i]*0.12;
            }
            if (bConf >= 0.82 && st.highConf >= 5 && (f - startFrame) % 8 === 0) {
              st.anchorTpl = _blendTemplate(st.anchorTpl, fresh, 0.08);
              for (let i = 0; i < st.anchorEdg.length; i++) st.anchorEdg[i] = st.anchorEdg[i]*0.92 + fEdg[i]*0.08;
              for (let i = 0; i < st.anchorHist.length; i++) st.anchorHist[i] = st.anchorHist[i]*0.92 + fHist[i]*0.08;
            }
          }
          if (featureBest && (featureBest.count >= 3 || featureBest.score <= 28 || (f-startFrame)%3===0 || bConf < 0.5)) {
            if (_isFiniteFeatureModel(featureBest.model)) {
              const mb = featureBest.count >= 5 && featureBest.score <= 30 ? 0.34 : (bConf >= 0.58 ? 0.22 : 0.14);
              st.featureModel = _blendFeatureModel(st.featureModel, featureBest.model, mb);
            }
            st.features = _refreshFeatureTrackers(video, best, st.features, featureBest.matches||[], st.featureModel);
          } else if ((f - startFrame) % 3 === 0 || bConf < 0.42) {
            st.features = _refreshFeatureTrackers(video, best, st.features, [], st.featureModel);
          }
          st.prevPos = best;
          if (currLkPyr) st.prevLkPyr = currLkPyr;
          if ((f - startFrame) % 6 === 0) {
            const pct = Math.round((f - startFrame) / Math.max(1, st.endFrame - startFrame) * 100);
            const eng = best.source === 'features' ? 'Features'
                      : best.source === 'lk-flow' ? 'LK Flow'
                      : best.source === 'lk-ctx' ? 'LK Context'
                      : best.source === 'lk-scene' ? 'Scene Motion'
                      : best.source === 'anchor-local' || best.source === 'global-anchor' ? 'Anchor'
                      : best.source === 'stable-local' || best.source === 'global-stable' ? 'Stable'
                      : best.source === 'dynamic-global' ? 'Global'
                      : best.source === 'predict' ? 'Predict'
                      : 'Template';
            _setTrackTelemetry(st.shape.id, {
              engine: eng,
              confidence: bConf,
              progress: pct,
              profileLabel: st.trackProfile.label,
              profileDesc: _describeTrackingProfile(st.trackProfile),
              frame: f,
            });
          }
        }
        renderTimeline();
      }
    } catch {}

    for (const st of states) {
      const smoothed = _buildTrackedKeyframesFromSamples({
        samples: st.samples, usesOffsetTrack: st.uot,
        startCx: st.startCx, startCy: st.startCy,
        width: st.lW, height: st.lH,
      });
      if (smoothed.length) { st.shape.keyframes = smoothed; st.shape.trackInterpolation = 'hold'; }
      _setTrackTelemetry(st.shape.id, {
        engine: st.cutDone ? 'Cut' : (_trackingAborted ? 'Stopped' : 'Complete'),
        confidence: st.cutDone ? 0 : (_trackingAborted ? 0 : 1),
        progress: st.cutDone ? Math.min(99, Math.round((Math.max(startFrame, st.samples[st.samples.length - 1]?.frame || startFrame) - startFrame) / Math.max(1, st.endFrame - startFrame) * 100)) : (_trackingAborted ? 0 : 100),
        profileLabel: st.trackProfile.label,
        profileDesc: _describeTrackingProfile(st.trackProfile),
        frame: st.samples[st.samples.length - 1]?.frame || startFrame,
      });
    }
    const wasAborted = _trackingAborted;
    _isTracking = false; _trackingAborted = false;
    video.currentTime = frameToMediaTime(startFrame);
    await new Promise(r => {
      const onS = () => { clearTimeout(t); r(); };
      const t = setTimeout(() => { video.removeEventListener('seeked', onS); r(); }, 1200);
      video.addEventListener('seeked', onS, { once: true });
    });
    pushState(); render(true); updateTrackBtnState();
    _showAiToast(wasAborted
      ? `Tracking stopped after ${targets.length} shape${targets.length > 1 ? 's' : ''}`
      : `${targets.length} shape${targets.length > 1 ? 's' : ''} tracked`, true);
  };

  // ── Detect all subjects then immediately track them in parallel ─────────────
  const _detectAndTrackAll = async () => {
    if (_isTracking || _isDetecting || !video) return;
    _setDetecting(true, btnAiScanAll);
    const beforeIds = new Set(objects.map(o => o.id));
    try {
      const faces   = _detectFacesRects();   if (faces.length)   _pushDetectedRects(faces,   'Face',         '#ff7a7a');
      const screens = _detectScreensRects(); if (screens.length) _pushDetectedRects(screens, 'Screen Comp',  '#2ed8ff');
      const texts   = _detectTextRects();    if (texts.length)   _pushDetectedRects(texts,   'Text Removal', '#ffd166');
    } catch {}
    _setDetecting(false);
    const newShapes = objects.filter(o => !beforeIds.has(o.id) && _isTrackableShape(o));
    if (!newShapes.length) { _showAiToast('No subjects detected'); return; }
    _showAiToast(`Detected ${newShapes.length} subject${newShapes.length > 1 ? 's' : ''} — tracking…`);
    await _trackAllParallel(newShapes);
  };

  // ── AI Detection helpers ────────────────────────────────────────────────────
  const _videoToLogical = (vx, vy, vw, vh) => {
    const srcW = video ? (video.videoWidth  || logicalW) : (baseMedia?.naturalWidth  || logicalW);
    const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
    const scX = Math.max(1, srcW) / Math.max(1, logicalW);
    const scY = Math.max(1, srcH) / Math.max(1, logicalH);
    return { x: vx / scX, y: vy / scY, w: vw / scX, h: vh / scY };
  };

  const _captureFrameBitmap = async () => {
    const srcW = video ? (video.videoWidth  || logicalW) : (baseMedia?.naturalWidth  || logicalW);
    const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
    const oc = _makeOffscreen(srcW, srcH);
    oc.getContext('2d').drawImage(baseMedia, 0, 0, srcW, srcH);
    return await createImageBitmap(oc);
  };

  const _mergeRects = (blocks, proximity) => {
    if (!blocks.length) return [];
    const used = new Uint8Array(blocks.length);
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      if (used[i]) continue;
      let { x, y, w, h } = blocks[i];
      used[i] = 1;
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < blocks.length; j++) {
          if (used[j]) continue;
          const b = blocks[j];
          if (b.x <= x+w+proximity && b.x+b.w >= x-proximity &&
              b.y <= y+h+proximity && b.y+b.h >= y-proximity) {
            const x2 = Math.max(x+w, b.x+b.w), y2 = Math.max(y+h, b.y+b.h);
            x = Math.min(x, b.x); y = Math.min(y, b.y);
            w = x2-x; h = y2-y;
            used[j] = 1; changed = true;
          }
        }
      }
      out.push({ x, y, w, h });
    }
    return out;
  };

  // _setDetecting(flag, activeBtn?)
  // activeBtn: the specific button currently running — gets 'is-running' highlight.
  // All other buttons get 'is-detecting' (dimmed/disabled).
  // When flag=false: clears all states regardless of activeBtn.
  let _runningBtn = null;
  const _setDetecting = (flag, activeBtn = null) => {
    _isDetecting = flag;
    stage?.classList.toggle('is-ai-scanning', flag);
    modal?.classList.toggle('is-ai-scanning', flag);
    const statusBadge = head.querySelector('.sm-anno-ai-status');
    if (statusBadge) { statusBadge.textContent = flag ? 'ANALYZING' : 'READY'; statusBadge.dataset.state = flag ? 'analyzing' : 'ready'; }
    if (!flag) {
      // Clear all running/detecting states
      if (_runningBtn) {
        _runningBtn.classList.remove('is-running');
        const rl = _runningBtn.querySelector('.sm-anno-ai-label');
        if (rl && _runningBtn.dataset.origLabel) { rl.textContent = _runningBtn.dataset.origLabel; delete _runningBtn.dataset.origLabel; }
        _runningBtn = null;
      }
    }
    [btnAiDetectFaces, btnAiDetectScreens, btnAiDetectText, btnAiSmartSuggest,
     btnAiScanAll, btnAiDetectKeys, btnAiDetectMatte, btnAiDetectWire, btnAiEdgeSnap,
     btnAiSamMode, btnAiDetectML, btnAiDepthMap,
     btnAiPlanarTrack, btnAiDepthTrack, btnAiFlowViz, btnAiSmoothPath].forEach(b => {
      if (!b) return;
      b.disabled = flag;
      b.classList.toggle('is-detecting', flag && b !== activeBtn);
      b.classList.toggle('is-running',   flag && b === activeBtn);
    });
    if (flag && activeBtn) {
      _runningBtn = activeBtn;
      const rl = activeBtn.querySelector('.sm-anno-ai-label');
      if (rl && !activeBtn.dataset.origLabel) activeBtn.dataset.origLabel = rl.textContent;
    }
  };

  const _pushDetectedRects = (rects, suggestedNoteType, overrideColor) => {
    if (!rects.length) return;
    const meta = readMeta();
    const styleColor = overrideColor || color;
    const style = { color: styleColor, width, opacity };
    const frameIn = _getDefaultFrameIn(), frameOut = _getDefaultFrameOut();
    rects.forEach(({ x1, y1, x2, y2 }) => {
      objects.push({ id: genId(), kind: 'rect',
        x1: Math.max(0, x1), y1: Math.max(0, y1),
        x2: Math.min(logicalW, x2), y2: Math.min(logicalH, y2),
        style, meta, frameIn, frameOut, keyframes: [] });
    });
    pushState(); render(true);
    wrap?.classList.add('sm-anno-ai-flash');
    setTimeout(() => wrap?.classList.remove('sm-anno-ai-flash'), 600);
    const label = suggestedNoteType
      ? `${rects.length} ${suggestedNoteType}${rects.length > 1 ? 's' : ''} detected`
      : `${rects.length} region${rects.length > 1 ? 's' : ''} detected`;
    _showAiToast(label, true);
  };

  const _showAiToast = (msg, isSuccess = false) => {
    const stack = head.querySelector('.sm-anno-headstack') || head;
    const existing = stack.querySelector('.sm-anno-ai-toast');
    if (existing) existing.remove();
    if (_aiToastTimer) { clearTimeout(_aiToastTimer); _aiToastTimer = null; }
    const chip = document.createElement('div');
    chip.className = 'sm-anno-ai-toast' + (isSuccess ? ' is-success' : '');
    chip.textContent = msg;
    stack.appendChild(chip);
    _aiToastTimer = setTimeout(() => {
      chip.classList.add('is-fading');
      setTimeout(() => { try { chip.remove(); } catch {} }, 300);
    }, 2800);
  };

  const _detectFacesRects = ()=>{
    const AW = 320, AH = Math.round(320 * (logicalH / Math.max(1, logicalW)));
    const oc = _makeOffscreen(AW, AH);
    const octx = oc.getContext('2d');
    octx.drawImage(baseMedia, 0, 0, AW, AH);
    const { data } = octx.getImageData(0, 0, AW, AH);

    // Mark skin pixels using YCbCr thresholds (works across diverse skin tones)
    const skin = new Uint8Array(AW * AH);
    for (let i = 0; i < AW * AH; i++) {
      const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      const Y  =  0.299*r + 0.587*g + 0.114*b;
      const Cb = -0.169*r - 0.331*g + 0.500*b + 128;
      const Cr =  0.500*r - 0.419*g - 0.081*b + 128;
      skin[i] = (Y > 30 && Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173) ? 1 : 0;
    }

    // Block-based skin density (8×8 blocks, >35% skin = active)
    const BLOCK = 8;
    const BW = Math.ceil(AW / BLOCK), BH = Math.ceil(AH / BLOCK);
    const blocks = new Uint8Array(BW * BH);
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        let cnt = 0, tot = 0;
        for (let dy = 0; dy < BLOCK && by*BLOCK+dy < AH; dy++)
          for (let dx = 0; dx < BLOCK && bx*BLOCK+dx < AW; dx++) { cnt += skin[(by*BLOCK+dy)*AW+(bx*BLOCK+dx)]; tot++; }
        blocks[by*BW+bx] = (cnt/tot) > 0.35 ? 1 : 0;
      }
    }

    // Connected-component labeling (raster scan + union-find)
    const labels = new Int32Array(BW * BH);
    let nextL = 1;
    const par = [0];
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const union = (a, b) => { par[find(a)] = find(b); };
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        if (!blocks[by*BW+bx]) continue;
        const L = bx > 0 ? labels[by*BW+bx-1] : 0;
        const A = by > 0 ? labels[(by-1)*BW+bx] : 0;
        if (!L && !A) { labels[by*BW+bx] = nextL; par.push(nextL); nextL++; }
        else if (L && !A) { labels[by*BW+bx] = L; }
        else if (!L && A) { labels[by*BW+bx] = A; }
        else { labels[by*BW+bx] = L; if (L !== A) union(L, A); }
      }
    }

    // Compute bounding boxes per resolved label
    const bb = {};
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        let lbl = labels[by*BW+bx]; if (!lbl) continue;
        lbl = find(lbl);
        if (!bb[lbl]) bb[lbl] = { x1: bx, y1: by, x2: bx, y2: by, n: 0 };
        const b = bb[lbl];
        b.x1 = Math.min(b.x1,bx); b.y1 = Math.min(b.y1,by);
        b.x2 = Math.max(b.x2,bx); b.y2 = Math.max(b.y2,by);
        b.n++;
      }
    }

    const scX = logicalW / AW, scY = logicalH / AH;
    return Object.values(bb)
      .filter(b => b.n >= 6)
      .filter(b => { const ar = (b.x2-b.x1+1) / Math.max(1, b.y2-b.y1+1); return ar >= 0.3 && ar <= 2.2; })
      .map(b => ({
        // Expand slightly: skin mask undershoots the full head region
        x1: Math.max(0,        (b.x1*BLOCK - BLOCK)     * scX),
        y1: Math.max(0,        (b.y1*BLOCK - BLOCK*1.5) * scY),
        x2: Math.min(logicalW, (b.x2*BLOCK + BLOCK*2)   * scX),
        y2: Math.min(logicalH, (b.y2*BLOCK + BLOCK)     * scY),
      }));
  };

  // Pure-canvas face detection via YCbCr skin-tone segmentation + connected components.
  // Works in all browsers without the Chrome-Android-only Shape Detection API.
  const _aiDetectFaces = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectFaces);
    try {
      const rects = _detectFacesRects();
      if (rects.length) { _pushDetectedRects(rects, 'Face', '#ff7a7a'); _setBtnBadge(btnAiDetectFaces, rects.length); }
      else { _showAiToast('No faces detected in this frame'); _setBtnBadge(btnAiDetectFaces, 0); }
    } catch(err) { _showAiToast('Face detection failed'); }
    finally { _setDetecting(false); }
  };

  const _detectTextRects = ()=>{
    const AW = 320, AH = Math.round(320 * (logicalH / Math.max(1, logicalW)));
    const oc = _makeOffscreen(AW, AH);
    const octx = oc.getContext('2d');
    octx.drawImage(baseMedia, 0, 0, AW, AH);
    const { data } = octx.getImageData(0, 0, AW, AH);

    // Compute horizontal gradient magnitude (text = high horizontal contrast)
    const grad = new Float32Array(AW * AH);
    for (let y = 1; y < AH-1; y++) {
      for (let x = 1; x < AW-1; x++) {
        const i = (y*AW+x)*4;
        const lum  = 0.299*data[i]       + 0.587*data[i+1]       + 0.114*data[i+2];
        const lumR = 0.299*data[i+4]     + 0.587*data[i+5]       + 0.114*data[i+6];
        const lumD = 0.299*data[i+AW*4]  + 0.587*data[i+AW*4+1]  + 0.114*data[i+AW*4+2];
        grad[y*AW+x] = Math.abs(lumR - lum) * 2 + Math.abs(lumD - lum);
      }
    }

    // Block-based gradient density (8×8, threshold ≥18 = text-like)
    const BLOCK = 8, TEXT_THRESH = 18;
    const BW = Math.ceil(AW/BLOCK), BH = Math.ceil(AH/BLOCK);
    const blocks = new Uint8Array(BW * BH);
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        let sum = 0, cnt = 0;
        for (let dy = 0; dy < BLOCK && by*BLOCK+dy < AH; dy++)
          for (let dx = 0; dx < BLOCK && bx*BLOCK+dx < AW; dx++) { sum += grad[(by*BLOCK+dy)*AW+(bx*BLOCK+dx)]; cnt++; }
        blocks[by*BW+bx] = (sum/cnt) >= TEXT_THRESH ? 1 : 0;
      }
    }

    // Collect horizontal text-line segments (≥3 consecutive active blocks in a row)
    const lines = [];
    for (let by = 0; by < BH; by++) {
      let start = -1;
      for (let bx = 0; bx <= BW; bx++) {
        if (bx < BW && blocks[by*BW+bx]) { if (start < 0) start = bx; }
        else if (start >= 0) { if (bx - start >= 3) lines.push({ x1: start, x2: bx-1, y: by }); start = -1; }
      }
    }

    // Merge nearby lines into text blocks
    lines.sort((a, b) => a.y - b.y || a.x1 - b.x1);
    const regions = [];
    for (const ln of lines) {
      let hit = null;
      for (const reg of regions) {
        if (ln.y <= reg.y2 + 2 && ln.x1 <= reg.x2 + 2 && ln.x2 >= reg.x1 - 2) { hit = reg; break; }
      }
      if (hit) {
        hit.x1 = Math.min(hit.x1, ln.x1); hit.x2 = Math.max(hit.x2, ln.x2); hit.y2 = Math.max(hit.y2, ln.y);
      } else {
        regions.push({ x1: ln.x1, x2: ln.x2, y1: ln.y, y2: ln.y });
      }
    }

    const scX = logicalW / AW, scY = logicalH / AH;
    return regions
      .filter(r => (r.x2 - r.x1) >= 3)
      .map(r => ({
        x1: Math.max(0,        r.x1 * BLOCK * scX),
        y1: Math.max(0,        r.y1 * BLOCK * scY),
        x2: Math.min(logicalW, (r.x2+1) * BLOCK * scX),
        y2: Math.min(logicalH, (r.y2+1) * BLOCK * scY),
      }));
  };

  // Pure-canvas text region detection via horizontal gradient density analysis.
  const _aiDetectText = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectText);
    try {
      const rects = _detectTextRects();
      if (rects.length) { _pushDetectedRects(rects, 'Text Removal', '#ffd166'); _setBtnBadge(btnAiDetectText, rects.length); }
      else { _showAiToast('No text regions detected in this frame'); _setBtnBadge(btnAiDetectText, 0); }
    } catch(err) { _showAiToast('Text detection failed'); }
    finally { _setDetecting(false); }
  };

  const _detectScreensRects = ()=>{
    const AW = 320, AH = Math.round(320 * (logicalH / Math.max(1, logicalW)));
    const oc = _makeOffscreen(AW, AH);
    const octx = oc.getContext('2d');
    octx.drawImage(baseMedia, 0, 0, AW, AH);
    const { data } = octx.getImageData(0, 0, AW, AH);
    const lum = new Uint8Array(AW * AH);
    for (let i = 0; i < AW * AH; i++) {
      lum[i] = Math.round(0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2]);
    }
    const THRESH = 210, BLOCK = 16;
    const candidates = [];
    for (let by = 0; by < AH - BLOCK; by += BLOCK) {
      for (let bx = 0; bx < AW - BLOCK; bx += BLOCK) {
        let sum = 0;
        for (let dy = 0; dy < BLOCK; dy++)
          for (let dx = 0; dx < BLOCK; dx++)
            sum += lum[(by+dy)*AW + (bx+dx)];
        if (sum / (BLOCK*BLOCK) > THRESH) candidates.push({ x: bx, y: by, w: BLOCK, h: BLOCK });
      }
    }
    const merged = _mergeRects(candidates, BLOCK);
    const MIN_AREA = AW * AH * 0.04;
    const valid = merged.filter(r => r.w * r.h >= MIN_AREA);
    const scX = logicalW / AW, scY = logicalH / AH;
    return valid.map(r => ({ x1: r.x*scX, y1: r.y*scY, x2: (r.x+r.w)*scX, y2: (r.y+r.h)*scY }));
  };

  const _aiDetectScreens = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectScreens);
    try {
      const rects = _detectScreensRects();
      if (rects.length) { _pushDetectedRects(rects, 'Screen Comp', '#2ed8ff'); _setBtnBadge(btnAiDetectScreens, rects.length); }
      else { _showAiToast('No bright screen regions found'); _setBtnBadge(btnAiDetectScreens, 0); }
    } catch(err) { _showAiToast('Screen detection failed'); }
    finally { _setDetecting(false); }
  };

  const _aiSmartSuggest = async () => {
    if (_isDetecting) return;
    const sel = objects.find(o => o.id === selectedId);
    if (!sel || (sel.kind !== 'rect' && sel.kind !== 'ellipse')) {
      _showAiToast('Select a rect or ellipse first'); return;
    }
    _setDetecting(true, btnAiSmartSuggest);
    try {
      const srcW = video ? (video.videoWidth  || logicalW) : (baseMedia?.naturalWidth  || logicalW);
      const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
      const scX = srcW / logicalW, scY = srcH / logicalH;
      const rx = Math.min(sel.x1, sel.x2)*scX, ry = Math.min(sel.y1, sel.y2)*scY;
      const rw = Math.abs(sel.x2-sel.x1)*scX, rh = Math.abs(sel.y2-sel.y1)*scY;
      const SNAP = 128;
      const oc = _makeOffscreen(SNAP, SNAP);
      oc.getContext('2d').drawImage(baseMedia, rx, ry, Math.max(1, rw), Math.max(1, rh), 0, 0, SNAP, SNAP);
      let suggestion = null;

      // Skin-tone check (YCbCr) → Face
      if (!suggestion) {
        const { data: sd } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
        let skinPx = 0;
        for (let i = 0; i < SNAP*SNAP; i++) {
          const r = sd[i*4], g = sd[i*4+1], b = sd[i*4+2];
          const Y  =  0.299*r + 0.587*g + 0.114*b;
          const Cb = -0.169*r - 0.331*g + 0.500*b + 128;
          const Cr =  0.500*r - 0.419*g - 0.081*b + 128;
          if (Y > 30 && Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173) skinPx++;
        }
        if (skinPx / (SNAP*SNAP) > 0.25) suggestion = 'Face';
      }
      // Horizontal gradient density check → Text Removal
      if (!suggestion) {
        const { data: td } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
        let gradSum = 0;
        for (let y = 0; y < SNAP-1; y++) {
          for (let x = 0; x < SNAP-1; x++) {
            const i = (y*SNAP+x)*4;
            const lum  = 0.299*td[i]   + 0.587*td[i+1]   + 0.114*td[i+2];
            const lumR = 0.299*td[i+4] + 0.587*td[i+5]   + 0.114*td[i+6];
            gradSum += Math.abs(lumR - lum);
          }
        }
        if (gradSum / (SNAP*SNAP) > 12) suggestion = 'Text Removal';
      }
      // High average luminance → Screen Comp
      if (!suggestion) {
        const { data: ld } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
        let lumSum = 0;
        for (let i = 0; i < SNAP*SNAP; i++) lumSum += 0.299*ld[i*4] + 0.587*ld[i*4+1] + 0.114*ld[i*4+2];
        if (lumSum / (SNAP*SNAP) > 200) suggestion = 'Screen Comp';
      }

      // Additional checks: Green/Blue Screen, Sky, Shadow, Wire/Rig
      if (!suggestion) {
        const { data: cd } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
        let greenPx = 0, bluePx = 0;
        for (let i = 0; i < SNAP*SNAP; i++) {
          const r = cd[i*4], g = cd[i*4+1], b = cd[i*4+2];
          if (g > 90 && g > r*1.35 && g > b*1.35 && g-Math.max(r,b) > 35) greenPx++;
          else if (b > 90 && b > r*1.35 && b > g*1.25 && b-Math.max(r,g) > 35) bluePx++;
        }
        const keyPct = Math.max(greenPx, bluePx) / (SNAP*SNAP);
        if (keyPct > 0.22) suggestion = greenPx >= bluePx ? 'Green Screen' : 'Blue Screen';
      }
      // Sky: high-lum blue tones in upper portion
      if (!suggestion) {
        const { data: sky } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP/2);
        let skyPx = 0;
        for (let i = 0; i < SNAP*(SNAP/2); i++) {
          const r = sky[i*4], g = sky[i*4+1], b = sky[i*4+2];
          const Y = 0.299*r + 0.587*g + 0.114*b;
          if (Y > 100 && b > r && b > g*0.85) skyPx++;
        }
        if (skyPx / (SNAP*SNAP/2) > 0.30) suggestion = 'Sky';
      }
      // Shadow: predominantly dark with varied luminance (not uniform black)
      if (!suggestion) {
        const { data: sh } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
        let darkPx = 0, varSum = 0;
        const lums = [];
        for (let i = 0; i < SNAP*SNAP; i++) {
          const L = 0.299*sh[i*4] + 0.587*sh[i*4+1] + 0.114*sh[i*4+2];
          lums.push(L); if (L < 60) darkPx++;
        }
        if (darkPx / (SNAP*SNAP) > 0.45) {
          const mean = lums.reduce((a,b)=>a+b,0)/lums.length;
          varSum = lums.reduce((a,b)=>a+(b-mean)**2,0)/lums.length;
          if (varSum > 80) suggestion = 'Shadow';
        }
      }

      if (suggestion) {
        _showAiToast(`Suggested: ${suggestion}`, true);
        // Auto-select note type
        if (ntSel) {
          const opts = Array.from(ntSel.options);
          const match = opts.find(o => {
            const parts = (o.value||'').split('|');
            return parts[1] === suggestion || parts[0] === suggestion || (parts[1]||'').includes(suggestion.split(' ')[0]);
          });
          if (match) { ntSel.value = match.value; ntSel.dispatchEvent(new Event('change')); }
        }
        // Auto-fill note text if empty
        const autoNote = _aiSmartSuggestNote(suggestion);
        if (autoNote && noteInp && !noteInp.value.trim()) {
          noteInp.value = autoNote;
          noteInp.dispatchEvent(new Event('input'));
        }
      } else {
        _showAiToast('No clear match — try a more specific region');
      }
    } catch(err) { _showAiToast('Suggest failed'); }
    finally { _setDetecting(false); }
  };

  // ── AI: Green/Blue Screen (chroma key) detector ────────────────────────────
  const _detectKeyRects = () => {
    const AW = 320, AH = Math.round(320 * (logicalH / Math.max(1, logicalW)));
    const oc = _makeOffscreen(AW, AH);
    const octx = oc.getContext('2d');
    octx.drawImage(baseMedia, 0, 0, AW, AH);
    const { data } = octx.getImageData(0, 0, AW, AH);
    const mask = new Uint8Array(AW * AH);
    let greenPx = 0, bluePx = 0;
    for (let i = 0; i < AW * AH; i++) {
      const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      // Greenscreen: G clearly dominant, saturated
      if (g > 100 && g > r * 1.4 && g > b * 1.4 && g - Math.max(r,b) > 40) { mask[i] = 1; greenPx++; }
      // Bluescreen: B clearly dominant, saturated
      else if (b > 100 && b > r * 1.4 && b > g * 1.3 && b - Math.max(r,g) > 40) { mask[i] = 2; bluePx++; }
    }
    const dominantKey = greenPx >= bluePx ? 1 : 2;
    const label = dominantKey === 1 ? 'Green Screen' : 'Blue Screen';
    const color = dominantKey === 1 ? '#2ecc71' : '#3498db';
    const BLOCK = 12;
    const BW = Math.ceil(AW/BLOCK), BH = Math.ceil(AH/BLOCK);
    const blocks = new Uint8Array(BW * BH);
    for (let by = 0; by < BH; by++)
      for (let bx = 0; bx < BW; bx++) {
        let cnt = 0, tot = 0;
        for (let dy = 0; dy < BLOCK && by*BLOCK+dy < AH; dy++)
          for (let dx = 0; dx < BLOCK && bx*BLOCK+dx < AW; dx++) { if (mask[(by*BLOCK+dy)*AW+(bx*BLOCK+dx)] === dominantKey) cnt++; tot++; }
        blocks[by*BW+bx] = cnt/tot > 0.40 ? 1 : 0;
      }
    const rects = _blockComponentsToRects(blocks, BW, BH, BLOCK, 4, logicalW/AW, logicalH/AH);
    return { rects, label, color };
  };

  const _aiDetectKeys = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectKeys);
    try {
      const { rects, label, color } = _detectKeyRects();
      if (rects.length) _pushDetectedRects(rects, label, color);
      else _showAiToast('No chroma key area detected');
    } catch(err) { _showAiToast('Key detection failed'); }
    finally { _setDetecting(false); }
  };

  // ── AI: Hard matte / letterbox detector ────────────────────────────────────
  const _detectMatteRects = () => {
    const AW = 320, AH = Math.round(320 * (logicalH / Math.max(1, logicalW)));
    const oc = _makeOffscreen(AW, AH);
    const octx = oc.getContext('2d');
    octx.drawImage(baseMedia, 0, 0, AW, AH);
    const { data } = octx.getImageData(0, 0, AW, AH);
    const rowLum = new Float32Array(AH);
    const colLum = new Float32Array(AW);
    for (let y = 0; y < AH; y++) {
      let s = 0;
      for (let x = 0; x < AW; x++) s += 0.299*data[(y*AW+x)*4] + 0.587*data[(y*AW+x)*4+1] + 0.114*data[(y*AW+x)*4+2];
      rowLum[y] = s / AW;
    }
    for (let x = 0; x < AW; x++) {
      let s = 0;
      for (let y = 0; y < AH; y++) s += 0.299*data[(y*AW+x)*4] + 0.587*data[(y*AW+x)*4+1] + 0.114*data[(y*AW+x)*4+2];
      colLum[x] = s / AH;
    }
    const DARK = 18;
    // Find top/bottom dark bars
    let topBar = 0, bottomBar = AH;
    for (let y = 0; y < AH/3; y++) { if (rowLum[y] < DARK) topBar = y+1; else break; }
    for (let y = AH-1; y > AH*2/3; y--) { if (rowLum[y] < DARK) bottomBar = y; else break; }
    // Find left/right dark bars
    let leftBar = 0, rightBar = AW;
    for (let x = 0; x < AW/3; x++) { if (colLum[x] < DARK) leftBar = x+1; else break; }
    for (let x = AW-1; x > AW*2/3; x--) { if (colLum[x] < DARK) rightBar = x; else break; }
    const scX = logicalW/AW, scY = logicalH/AH;
    const rects = [];
    if (topBar > 2)            rects.push({ x1: 0, y1: 0, x2: logicalW, y2: topBar*scY });
    if (bottomBar < AH-2)      rects.push({ x1: 0, y1: bottomBar*scY, x2: logicalW, y2: logicalH });
    if (leftBar > 2)           rects.push({ x1: 0, y1: 0, x2: leftBar*scX, y2: logicalH });
    if (rightBar < AW-2)       rects.push({ x1: rightBar*scX, y1: 0, x2: logicalW, y2: logicalH });
    return rects;
  };

  const _aiDetectMatte = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectMatte);
    try {
      const rects = _detectMatteRects();
      if (rects.length) _pushDetectedRects(rects, 'Hard Matte', '#e67e22');
      else _showAiToast('No hard matte detected — frame appears full-aperture');
    } catch(err) { _showAiToast('Matte detection failed'); }
    finally { _setDetecting(false); }
  };

  // ── AI: Edge-snap selected rect to object edges (Sobel + bbox contraction) ─
  const _aiEdgeSnap = async () => {
    const sel = objects.find(o => o.id === selectedId);
    if (!sel || (sel.kind !== 'rect' && sel.kind !== 'ellipse')) {
      _showAiToast('Select a rect or ellipse first'); return;
    }
    if (_isDetecting) return;
    _setDetecting(true, btnAiEdgeSnap);
    try {
      const srcW = video ? (video.videoWidth  || logicalW) : (baseMedia?.naturalWidth  || logicalW);
      const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
      const scX = srcW / Math.max(1, logicalW), scY = srcH / Math.max(1, logicalH);
      const x1s = Math.min(sel.x1, sel.x2), y1s = Math.min(sel.y1, sel.y2);
      const x2s = Math.max(sel.x1, sel.x2), y2s = Math.max(sel.y1, sel.y2);
      const rw = Math.round((x2s - x1s) * scX), rh = Math.round((y2s - y1s) * scY);
      if (rw < 8 || rh < 8) { _showAiToast('Region too small for edge snap'); _setDetecting(false); return; }
      const SNAP = Math.min(256, Math.max(64, rw, rh));
      const oc = _makeOffscreen(SNAP, SNAP);
      const oct = oc.getContext('2d');
      oct.drawImage(baseMedia, Math.round(x1s*scX), Math.round(y1s*scY), rw, rh, 0, 0, SNAP, SNAP);
      const { data } = oct.getImageData(0, 0, SNAP, SNAP);
      // Sobel edge magnitude
      const edge = new Float32Array(SNAP * SNAP);
      for (let y = 1; y < SNAP-1; y++)
        for (let x = 1; x < SNAP-1; x++) {
          const lum = (i) => 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
          const c = y*SNAP+x;
          const gx = -lum(c-SNAP-1) - 2*lum(c-1) - lum(c+SNAP-1) + lum(c-SNAP+1) + 2*lum(c+1) + lum(c+SNAP+1);
          const gy = -lum(c-SNAP-1) - 2*lum(c-SNAP) - lum(c-SNAP+1) + lum(c+SNAP-1) + 2*lum(c+SNAP) + lum(c+SNAP+1);
          edge[c] = Math.sqrt(gx*gx + gy*gy);
        }
      // Find tightest bbox where edge energy is significant (≥15% of max edge)
      const maxE = Math.max(...edge);
      const thresh = maxE * 0.15;
      let minX = SNAP, maxX = 0, minY = SNAP, maxY = 0;
      for (let y = 0; y < SNAP; y++)
        for (let x = 0; x < SNAP; x++)
          if (edge[y*SNAP+x] >= thresh) { minX = Math.min(minX,x); maxX = Math.max(maxX,x); minY = Math.min(minY,y); maxY = Math.max(maxY,y); }
      if (maxX <= minX || maxY <= minY) { _showAiToast('No clear edges found inside selection'); _setDetecting(false); return; }
      // Map snap coords back to logical coords with 2px margin
      const PAD = 2;
      const nx1 = x1s + (minX/SNAP) * (x2s-x1s) - PAD;
      const ny1 = y1s + (minY/SNAP) * (y2s-y1s) - PAD;
      const nx2 = x1s + (maxX/SNAP) * (x2s-x1s) + PAD;
      const ny2 = y1s + (maxY/SNAP) * (y2s-y1s) + PAD;
      sel.x1 = Math.max(0, nx1); sel.y1 = Math.max(0, ny1);
      sel.x2 = Math.min(logicalW, nx2); sel.y2 = Math.min(logicalH, ny2);
      if (sel.keyframes?.length) sel.keyframes = [{ frame: sel.keyframes[0]?.frame ?? currentFrameRef(), x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2 }];
      pushState(); render(true);
      _showAiToast('Snapped to object edges', true);
    } catch(err) { _showAiToast('Edge snap failed'); }
    finally { _setDetecting(false); }
  };

  // ── AI: Scan All — run every detector, deduplicate, annotate ───────────────
  const _aiScanAll = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiScanAll);
    _showAiToast('Scanning frame…');
    try {
      const initialCount = objects.length;
      const allRects = [];
      // Faces
      try { const r = _detectFacesRects();   r.forEach(x => allRects.push({ ...x, label: 'Face',         color: '#ff7a7a' })); } catch {}
      // Screens
      try { const r = _detectScreensRects(); r.forEach(x => allRects.push({ ...x, label: 'Screen Comp',  color: '#2ed8ff' })); } catch {}
      // Text
      try { const r = _detectTextRects();    r.forEach(x => allRects.push({ ...x, label: 'Text Removal', color: '#ffd166' })); } catch {}
      // Chroma key
      try { const { rects, label, color } = _detectKeyRects(); rects.forEach(x => allRects.push({ ...x, label, color })); } catch {}
      // Hard matte
      try { const r = _detectMatteRects();   r.forEach(x => allRects.push({ ...x, label: 'Hard Matte',   color: '#e67e22' })); } catch {}
      try { const r = _detectWireRects(); r.forEach(x => allRects.push({ ...x, label: 'Wire/Rig', color: '#e17055' })); } catch {}

      // Deduplicate: if two rects overlap >60% IoU, keep the larger one
      const keep = allRects.filter((a, i) => {
        for (let j = 0; j < i; j++) {
          const b = allRects[j];
          const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
          const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
          if (ix2 <= ix1 || iy2 <= iy1) continue;
          const interArea = (ix2-ix1)*(iy2-iy1);
          const aArea = (a.x2-a.x1)*(a.y2-a.y1), bArea = (b.x2-b.x1)*(b.y2-b.y1);
          const iou = interArea / (aArea + bArea - interArea);
          if (iou > 0.60) return false;
        }
        return true;
      });

      if (keep.length) {
        keep.forEach(({ x1, y1, x2, y2, label, color }) => {
          _pushDetectedRects([{ x1, y1, x2, y2 }], label, color);
        });
        _showAiToast(`Found ${keep.length} region${keep.length>1?'s':''}: ${[...new Set(keep.map(r=>r.label))].join(', ')}`, true);
      } else {
        _showAiToast('Nothing notable detected in this frame');
      }
    } catch(err) { _showAiToast('Scan failed'); }
    finally { _setDetecting(false); }
  };

  // ── Shared helper: convert block component map to logical rects ─────────────
  function _blockComponentsToRects(blocks, BW, BH, BLOCK, minBlocks, scX, scY) {
    const labels = new Int32Array(BW * BH);
    let nextL = 1;
    const par = [0];
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const union = (a, b) => { par[find(a)] = find(b); };
    for (let by = 0; by < BH; by++)
      for (let bx = 0; bx < BW; bx++) {
        if (!blocks[by*BW+bx]) continue;
        const L = bx > 0 ? labels[by*BW+bx-1] : 0;
        const A = by > 0 ? labels[(by-1)*BW+bx] : 0;
        if (!L && !A) { labels[by*BW+bx] = nextL; par.push(nextL); nextL++; }
        else if (L && !A) { labels[by*BW+bx] = L; }
        else if (!L && A) { labels[by*BW+bx] = A; }
        else { labels[by*BW+bx] = L; if (L !== A) union(L, A); }
      }
    const bb = {};
    for (let by = 0; by < BH; by++)
      for (let bx = 0; bx < BW; bx++) {
        let lbl = labels[by*BW+bx]; if (!lbl) continue;
        lbl = find(lbl);
        if (!bb[lbl]) bb[lbl] = { x1:bx, y1:by, x2:bx, y2:by, n:0 };
        const b = bb[lbl];
        b.x1=Math.min(b.x1,bx); b.y1=Math.min(b.y1,by); b.x2=Math.max(b.x2,bx); b.y2=Math.max(b.y2,by); b.n++;
      }
    return Object.values(bb)
      .filter(b => b.n >= minBlocks)
      .map(b => ({
        x1: Math.max(0,        b.x1*BLOCK*scX),
        y1: Math.max(0,        b.y1*BLOCK*scY),
        x2: Math.min(logicalW, (b.x2+1)*BLOCK*scX),
        y2: Math.min(logicalH, (b.y2+1)*BLOCK*scY),
      }));
  }

  // ── Enhanced Smart Suggest — more categories + auto-fill note ──────────────
  const _aiSmartSuggestNote = (suggestion) => {
    const NOTES = {
      'Face':          'Face/skin — cleanup or replacement required',
      'Screen Comp':   'Screen comp — insert replacement content',
      'Text Removal':  'Remove text/logo overlay — clean plate needed',
      'Green Screen':  'Pull green screen matte — key extraction required',
      'Blue Screen':   'Pull blue screen matte — key extraction required',
      'Hard Matte':    'Hard matte / letterbox — adjust or extend frame',
      'Sky':           'Sky replacement — composite new sky layer',
      'Shadow':        'Shadow — paint-out or re-light required',
      'Practical Light':'Practical light — remove or replace light source',
      'Wire/Rig':      'Wire/rig removal — clean plate and paint-out',
    };
    return NOTES[suggestion] || '';
  };

  // ── Result-count badge system — shows how many items a detector found ────────
  const _setBtnBadge = (btn, count) => {
    if (!btn) return;
    let badge = btn.querySelector('.sm-anno-ai-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sm-anno-ai-badge';
      btn.appendChild(badge);
    }
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  };

  // ── Progress label on button — shows download % during first-use model load ──
  const _setBtnProgress = (btn, pct, file = '') => {
    if (!btn) return;
    const label = btn.querySelector('.sm-anno-ai-label');
    if (!label) return;
    if (pct === null) {
      label.textContent = (btn.dataset.origLabel || label.textContent);
      btn.style.removeProperty('--pfx-run-pct');
      return;
    }
    if (!btn.dataset.origLabel) btn.dataset.origLabel = label.textContent;
    label.textContent = pct < 100 ? `${pct}%` : '✓';
    // Drive the CSS progress arc via custom property
    btn.style.setProperty('--pfx-run-pct', `${Math.round(pct)}%`);
  };

  // ── Wire / Rig detector — Probabilistic Hough line transform ─────────────────
  const _detectWireRects = () => {
    const AW = 320, AH = Math.round(320 * (logicalH / Math.max(1, logicalW)));
    const oc = _makeOffscreen(AW, AH);
    const octx = oc.getContext('2d');
    octx.drawImage(baseMedia, 0, 0, AW, AH);
    const { data } = octx.getImageData(0, 0, AW, AH);

    // Sobel edge magnitude
    const edge = new Float32Array(AW * AH);
    for (let y = 1; y < AH-1; y++)
      for (let x = 1; x < AW-1; x++) {
        const lum = (i) => 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
        const c = y*AW+x;
        const gx = -lum(c-AW-1) - 2*lum(c-1) - lum(c+AW-1) + lum(c-AW+1) + 2*lum(c+1) + lum(c+AW+1);
        const gy = -lum(c-AW-1) - 2*lum(c-AW) - lum(c-AW+1) + lum(c+AW-1) + 2*lum(c+AW) + lum(c+AW+1);
        edge[c] = Math.sqrt(gx*gx + gy*gy);
      }

    // Scan for thin diagonal/vertical line segments (potential wires)
    // A wire = a chain of high-edge pixels that stays narrow (width ≤ 2px)
    const THRESH = 55, MIN_LEN = 28, MAX_W = 3;
    const segments = [];
    // Vertical sweep
    for (let x = MAX_W; x < AW-MAX_W; x++) {
      let runStart = -1, runLen = 0;
      for (let y = 0; y < AH; y++) {
        const isEdge = edge[y*AW+x] >= THRESH;
        // Check that it's thin (not wide object)
        const leftW = edge[y*AW+Math.max(0,x-MAX_W)] < THRESH*0.5;
        const rightW = edge[y*AW+Math.min(AW-1,x+MAX_W)] < THRESH*0.5;
        if (isEdge && leftW && rightW) {
          if (runStart < 0) runStart = y;
          runLen++;
        } else {
          if (runLen >= MIN_LEN) segments.push({ x1:x-1,y1:runStart,x2:x+1,y2:runStart+runLen, axis:'v' });
          runStart = -1; runLen = 0;
        }
      }
      if (runLen >= MIN_LEN) segments.push({ x1:x-1,y1:runStart,x2:x+1,y2:runStart+runLen, axis:'v' });
    }
    // Diagonal sweep (±45°)
    for (let diag = -(AH-1); diag < AW; diag++) {
      let runStart = -1, runLen = 0, lastX = -1, lastY = -1;
      for (let y = 0; y < AH; y++) {
        const x = y + diag;
        if (x < 1 || x >= AW-1) continue;
        const isEdge = edge[y*AW+x] >= THRESH;
        if (isEdge) { if (runStart<0){runStart=y; lastX=x;} runLen++; lastY=y; }
        else { if (runLen >= MIN_LEN) segments.push({x1:x-runLen,y1:runStart,x2:x,y2:lastY,axis:'d'}); runStart=-1; runLen=0; }
      }
      if (runLen >= MIN_LEN) segments.push({x1:lastX-runLen,y1:runStart,x2:lastX,y2:lastY,axis:'d'});
    }

    // Deduplicate nearby segments and expand to annotation rects
    const PAD = 4;
    const scX = logicalW/AW, scY = logicalH/AH;
    return segments
      .filter((s, i) => segments.findIndex(t => Math.abs(t.x1-s.x1)<6 && Math.abs(t.y1-s.y1)<6) === i)
      .map(s => ({
        x1: Math.max(0,        (s.x1-PAD)*scX),
        y1: Math.max(0,        (s.y1-PAD)*scY),
        x2: Math.min(logicalW, (s.x2+PAD)*scX),
        y2: Math.min(logicalH, (s.y2+PAD)*scY),
      }));
  };

  const _aiDetectWire = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectWire);
    try {
      const rects = _detectWireRects();
      if (rects.length) {
        _pushDetectedRects(rects, 'Wire/Rig', '#e17055');
        _setBtnBadge(btnAiDetectWire, rects.length);
      } else {
        _showAiToast('No wires or rigs detected — try on a brighter frame');
        _setBtnBadge(btnAiDetectWire, 0);
      }
    } catch(err) { _showAiToast('Wire detection failed'); }
    finally { _setDetecting(false); }
  };

  // ── ML: YOLOS neural object detection ─────────────────────────────────────
  const _aiDetectML = async () => {
    if (_isDetecting) return;
    _setDetecting(true, btnAiDetectML);
    _showAiToast('Loading neural detector… (10 MB, first use only)');
    try {
      const { detectObjects } = await import(chrome.runtime.getURL('scripts/smart/smartAnnoAI.js'));
      _showAiToast('Running YOLOS detection…');
      const results = await detectObjects(baseMedia,
        (pct, file) => { _setBtnProgress(btnAiDetectML, pct, file); if (pct < 100) _showAiToast(`YOLOS: ${pct}%`); },
        0.45,
      );
      _setBtnProgress(btnAiDetectML, null);
      if (!results.length) { _showAiToast('Nothing detected'); return; }
      // VFX-relevant label → color map
      const LABEL_COLOR = {
        person: '#ff7a7a', face: '#ff7a7a',
        tv: '#2ed8ff', laptop: '#2ed8ff', cell_phone: '#2ed8ff', monitor: '#2ed8ff',
        car: '#ffd166', truck: '#ffd166', bus: '#ffd166', motorcycle: '#ffd166',
        airplane: '#9b59b6', boat: '#9b59b6',
      };
      const byLabel = {};
      results.forEach(r => {
        const lc = r.label.toLowerCase().replace(' ', '_');
        const color = LABEL_COLOR[lc] || '#b2bec3';
        const dispLabel = r.label.charAt(0).toUpperCase() + r.label.slice(1);
        if (!byLabel[dispLabel]) byLabel[dispLabel] = { rects: [], color };
        byLabel[dispLabel].rects.push({
          x1: r.box.x1 * logicalW, y1: r.box.y1 * logicalH,
          x2: r.box.x2 * logicalW, y2: r.box.y2 * logicalH,
        });
      });
      Object.entries(byLabel).forEach(([label, { rects, color }]) => {
        _pushDetectedRects(rects, label, color);
      });
      const total = results.length;
      const labels = [...new Set(results.map(r => r.label))];
      _showAiToast(`Found ${total} object${total>1?'s':''}: ${labels.slice(0,4).join(', ')}${labels.length>4?' …':''}`, true);
      _setBtnBadge(btnAiDetectML, total);
    } catch(err) {
      _setBtnProgress(btnAiDetectML, null);
      _showAiToast(`ML detect failed — ${err?.message?.includes('fetch') ? 'check network connection' : err?.message || 'unknown error'}`);
      console.warn('[AI] detectML', err);
    } finally { _setDetecting(false); }
  };

  // ── ML: Depth estimation overlay ───────────────────────────────────────────
  let _depthOverlayEl = null;
  const _aiDepthMap = async () => {
    // Toggle: if overlay is showing, remove it
    if (_depthOverlayEl) {
      _depthOverlayEl.remove(); _depthOverlayEl = null;
      btnAiDepthMap?.classList.remove('is-active-tool');
      _showAiToast('Depth overlay hidden');
      return;
    }
    if (_isDetecting) return;
    _setDetecting(true, btnAiDepthMap);
    _showAiToast('Loading depth model… (~19 MB first use)');
    try {
      const { estimateDepth } = await import(chrome.runtime.getURL('scripts/smart/smartAnnoAI.js'));
      _showAiToast('Estimating depth…');
      const imgData = await estimateDepth(baseMedia,
        (pct) => { if (pct < 100) _showAiToast(`Downloading depth model… ${pct}%`); },
      );
      // Render depth as a canvas overlay on top of the annotation canvas
      const dc = document.createElement('canvas');
      dc.className = 'sm-anno-depth-overlay';
      dc.width  = imgData.width;
      dc.height = imgData.height;
      dc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;border-radius:18px;mix-blend-mode:screen;opacity:0.55;';
      // Colorize: apply a viridis-like palette for better depth perception
      const colored = new ImageData(imgData.width, imgData.height);
      const src = imgData.data;
      for (let i = 0; i < imgData.width * imgData.height; i++) {
        const v = src[i * 4] / 255; // 0 (far) → 1 (near)
        // Viridis-like: far=blue, mid=green, near=yellow/red
        const r = Math.round(Math.min(255, v < 0.5 ? v*2*60 : 60 + (v-0.5)*2*195));
        const g = Math.round(Math.min(255, v < 0.5 ? v*2*160 : 160 + (v-0.5)*2*(-60)));
        const bl= Math.round(Math.min(255, v < 0.5 ? 140 + v*2*(-80) : 60 - (v-0.5)*2*60));
        colored.data[i*4]   = r;
        colored.data[i*4+1] = g;
        colored.data[i*4+2] = bl;
        colored.data[i*4+3] = src[i*4+3];
      }
      dc.getContext('2d').putImageData(colored, 0, 0);
      wrap?.appendChild(dc);
      _depthOverlayEl = dc;
      btnAiDepthMap?.classList.add('is-active-tool');
      _showAiToast('Depth map active — click Depth again to hide', true);
    } catch(err) {
      _showAiToast('Depth estimation failed — check network');
      console.warn('[AI] depthMap', err);
    } finally { _setDetecting(false); }
  };

  // ── ML: SAM click-to-segment mode ──────────────────────────────────────────
  let _samModeActive = false;
  let _samClickHandler = null;

  const _aiSamMode = () => {
    if (_samModeActive) {
      // Deactivate
      _samModeActive = false;
      btnAiSamMode?.classList.remove('is-active-tool');
      if (_samClickHandler) { canvas.removeEventListener('click', _samClickHandler); _samClickHandler = null; }
      _showAiToast('SAM mode off');
      return;
    }
    _samModeActive = true;
    btnAiSamMode?.classList.add('is-active-tool');
    _showAiToast('SAM mode — click any object to annotate it');

    _samClickHandler = async (ev) => {
      if (!_samModeActive || _isDetecting) return;
      _setDetecting(true, btnAiSamMode);
      const r = canvas.getBoundingClientRect();
      const nx = (ev.clientX - r.left) / (r.width  || 1);
      const ny = (ev.clientY - r.top)  / (r.height || 1);
      _showAiToast('Segmenting… (~35 MB on first use)');
      try {
        const { samClickSegment } = await import(chrome.runtime.getURL('scripts/smart/smartAnnoAI.js'));
        const box = await samClickSegment(baseMedia, nx, ny,
          (pct) => { if (pct < 100) _showAiToast(`Loading SAM… ${pct}%`); },
        );
        if (!box) { _showAiToast('No clear object found at click point'); _setDetecting(false); return; }
        const newShape = {
          id: `sam_${Date.now()}`,
          kind: 'rect',
          x1: box.x1 * logicalW, y1: box.y1 * logicalH,
          x2: box.x2 * logicalW, y2: box.y2 * logicalH,
          style: { color, width, opacity },
          frameIn: currentFrameRef(),
          frameOut: _getDefaultFrameOut(),
        };
        objects.push(newShape);
        selectedId = newShape.id;
        pushState(); render(true);
        _showAiToast('Object segmented — annotation added', true);
      } catch(err) {
        _showAiToast('SAM failed — check network connection');
        console.warn('[AI] SAM', err);
      } finally { _setDetecting(false); }
    };
    canvas.addEventListener('click', _samClickHandler);
  };

  // Dispose ML models when modal closes (cleanup memory)
  const _disposeMLModels = () => {
    try { import(chrome.runtime.getURL('scripts/smart/smartAnnoAI.js')).then(m => m.disposeAll()).catch(()=>{}); } catch {}
    try { import(chrome.runtime.getURL('scripts/smart/raftFlow.js')).then(m => m.disposeRaft()).catch(()=>{}); } catch {}
  };

  // ── 3D: Planar Tracker (RAFT flow + RANSAC homography) ─────────────────────
  let _planarTracker    = null;
  let _planarActive     = false;
  let _planarShapeId    = null;   // id of the rect being tracked as a plane
  let _planarCanvasEl   = null;   // overlay canvas for quad corners + grid
  let _depth3DTracker   = null;
  let _depth3DActive    = false;
  let _depth3DOverlayEl = null;

  const _makeFrameCanvas = () => {
    const fw = logicalW || video?.videoWidth || 1;
    const fh = logicalH || video?.videoHeight || 1;
    const oc = new OffscreenCanvas(fw, fh);
    oc.getContext('2d').drawImage(video || baseMedia, 0, 0, fw, fh);
    return oc;
  };

  const _aiPlanarTrack = async () => {
    const sel = objects.find(o => o.id === selectedId);
    if (!sel || sel.kind !== 'rect') { _showAiToast('Select a rect to define the tracked plane'); return; }
    if (_planarActive) {
      // Deactivate
      _planarActive = false; _planarShapeId = null;
      _planarTracker = null;
      if (_planarCanvasEl) { _planarCanvasEl.remove(); _planarCanvasEl = null; }
      btnAiPlanarTrack?.classList.remove('is-active-tool');
      _showAiToast('Planar tracker stopped');
      return;
    }
    if (_isDetecting) return;
    _setDetecting(true, btnAiPlanarTrack);
    try {
      const { PlanarTracker } = await import(chrome.runtime.getURL('scripts/smart/track3D.js'));
      const pt = new PlanarTracker();
      await pt.load((pct, f) => { if (pct < 100) _showAiToast(`Loading RAFT flow… ${pct}%`); });
      const x1 = Math.min(sel.x1, sel.x2), y1 = Math.min(sel.y1, sel.y2);
      const x2 = Math.max(sel.x1, sel.x2), y2 = Math.max(sel.y1, sel.y2);
      const corners = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
      pt.init(_makeFrameCanvas(), corners);
      _planarTracker = pt;
      _planarShapeId = sel.id;
      _planarActive  = true;
      btnAiPlanarTrack?.classList.add('is-active-tool');
      // Create overlay canvas for corner visualisation
      _planarCanvasEl = document.createElement('canvas');
      _planarCanvasEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;border-radius:18px;';
      wrap?.appendChild(_planarCanvasEl);
      _showAiToast('3D Planar tracker active — seek to track', true);
    } catch(e) {
      _showAiToast('Planar tracker failed — check network');
      console.warn('[3D]', e);
    } finally { _setDetecting(false); }
  };

  const _runPlanarTrackFrame = async () => {
    if (!_planarActive || !_planarTracker) return;
    const sel = objects.find(o => o.id === _planarShapeId);
    if (!sel) { _planarActive = false; return; }
    try {
      const res = await _planarTracker.track(_makeFrameCanvas());
      if (res.confidence < 0.15) { _showAiToast('Planar track lost — low confidence'); return; }
      // Update shape to match first corner as TL, last as BR
      const [tl,,br] = res.corners;
      sel.x1 = tl.x; sel.y1 = tl.y; sel.x2 = br.x; sel.y2 = br.y;
      if (sel.keyframes?.length) {
        const cf = currentFrameRef();
        sel.keyframes.push({ frame: cf, x1: tl.x, y1: tl.y, x2: br.x, y2: br.y });
      }
      // Draw quad outline + corner handles on overlay
      if (_planarCanvasEl) {
        _planarCanvasEl.width  = logicalW;
        _planarCanvasEl.height = logicalH;
        const ctx = _planarCanvasEl.getContext('2d');
        ctx.clearRect(0, 0, logicalW, logicalH);
        const c = res.corners;
        ctx.strokeStyle = 'rgba(84,213,255,0.85)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        c.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]);
        c.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(84,213,255,0.9)'; ctx.fill();
        });
        // Confidence badge
        ctx.fillStyle = res.confidence > 0.5 ? 'rgba(46,236,140,0.85)' : 'rgba(255,165,0,0.85)';
        ctx.font = 'bold 10px system-ui'; ctx.fillText(`3D ${Math.round(res.confidence*100)}%`, c[0].x+6, c[0].y-6);
      }
      pushState(); render(true);
    } catch {}
  };

  // ── 3D: Depth tracking overlay ────────────────────────────────────────────
  const _aiDepthTrack = async () => {
    if (_depth3DActive) {
      _depth3DActive = false; _depth3DTracker = null;
      if (_depth3DOverlayEl) { _depth3DOverlayEl.remove(); _depth3DOverlayEl = null; }
      btnAiDepthTrack?.classList.remove('is-active-tool');
      _showAiToast('3D Depth tracking stopped');
      return;
    }
    if (_isDetecting) return;
    _setDetecting(true, btnAiDepthTrack);
    try {
      const { DepthTracker } = await import(chrome.runtime.getURL('scripts/smart/track3D.js'));
      const dt = new DepthTracker();
      await dt.load((pct, f) => { _showAiToast(`Loading 3D engines… ${pct}% ${f ? '— ' + f.split('/').pop() : ''}`); });
      await dt.init(_makeFrameCanvas());
      _depth3DTracker = dt;
      _depth3DActive  = true;
      btnAiDepthTrack?.classList.add('is-active-tool');
      // Create overlay canvas for depth labels
      _depth3DOverlayEl = document.createElement('canvas');
      _depth3DOverlayEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;border-radius:18px;';
      wrap?.appendChild(_depth3DOverlayEl);
      _showAiToast('3D Depth tracker active — seek to see Z depth', true);
    } catch(e) {
      _showAiToast('3D Depth tracker failed — check network');
      console.warn('[3D]', e);
    } finally { _setDetecting(false); }
  };

  const _runDepthTrackFrame = async () => {
    if (!_depth3DActive || !_depth3DTracker || !objects.length) return;
    const pts = objects
      .filter(o => o.kind === 'rect' || o.kind === 'ellipse')
      .map(o => {
        const cf = currentFrameRef();
        const vis = o.keyframes?.length ? _interpShape(o, cf) : o;
        return { id: o.id, x: (vis.x1+vis.x2)/2, y: (vis.y1+vis.y2)/2 };
      });
    if (!pts.length) return;
    try {
      const res3d = await _depth3DTracker.update(_makeFrameCanvas(), pts.map(p => ({ x: p.x, y: p.y })));
      if (!_depth3DOverlayEl) return;
      _depth3DOverlayEl.width  = logicalW;
      _depth3DOverlayEl.height = logicalH;
      const ctx = _depth3DOverlayEl.getContext('2d');
      ctx.clearRect(0, 0, logicalW, logicalH);
      res3d.forEach((r, i) => {
        const pt  = pts[i];
        const pct = Math.round(r.Z * 100);
        const hue = Math.round((1 - r.Z) * 220); // near=red/orange, far=blue
        ctx.fillStyle    = `hsla(${hue},90%,65%,0.88)`;
        ctx.font         = 'bold 9px system-ui';
        ctx.textAlign    = 'center';
        // Z-depth pill
        const label = `Z ${pct}%`;
        const lw = ctx.measureText(label).width + 10;
        const lx = Math.max(lw/2, Math.min(logicalW-lw/2, r.x));
        const ly = Math.max(20, r.y - 14);
        ctx.fillStyle = `hsla(${hue},80%,20%,0.72)`;
        ctx.beginPath(); ctx.roundRect?.(lx-lw/2, ly-10, lw, 14, 4); ctx.fill();
        ctx.fillStyle = `hsla(${hue},90%,72%,0.95)`;
        ctx.fillText(label, lx, ly);
        // dz arrow (toward/away camera)
        if (Math.abs(r.dz) > 0.02) {
          const arrow = r.dz > 0 ? '▲ near' : '▼ far';
          ctx.fillStyle = r.dz > 0 ? 'rgba(255,100,80,0.85)' : 'rgba(80,160,255,0.85)';
          ctx.font = '8px system-ui';
          ctx.fillText(arrow, lx, ly + 12);
        }
      });
    } catch {}
  };

  // Hook: call 3D update functions when video seeks (after existing render)
  const _on3DFrameUpdate = () => {
    if (!hasVideoSource) return;
    if (_planarActive)  _runPlanarTrackFrame().catch(()=>{});
    if (_depth3DActive) _runDepthTrackFrame().catch(()=>{});
    if (_flowVizActive)   _runFlowVizFrame().catch(()=>{});
    if (_velHudActive)    _runVelocityHudFrame();
  };

  // ── Motion vector overlay (RAFT flow field visualised as arrows) ────────────
  let _flowVizActive   = false;
  let _flowVizOverlay  = null;
  let _flowPrevCanvas  = null;

  const _aiFlowViz = async () => {
    if (_flowVizActive) {
      _flowVizActive = false;
      if (_flowVizOverlay) { _flowVizOverlay.remove(); _flowVizOverlay = null; }
      _flowPrevCanvas = null;
      btnAiFlowViz?.classList.remove('is-active-tool');
      _showAiToast('Motion vectors hidden');
      return;
    }
    if (_isDetecting) return;
    _setDetecting(true, btnAiFlowViz);
    try {
      const { loadRaft } = await import(chrome.runtime.getURL('scripts/smart/raftFlow.js'));
      await loadRaft((pct, f) => { if (pct < 100) _showAiToast(`Loading optical flow… ${pct}%`); });
      const fw = logicalW || video?.videoWidth || 1;
      const fh = logicalH || video?.videoHeight || 1;
      _flowPrevCanvas = new OffscreenCanvas(fw, fh);
      _flowPrevCanvas.getContext('2d').drawImage(video || baseMedia, 0, 0, fw, fh);
      _flowVizOverlay = document.createElement('canvas');
      _flowVizOverlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;border-radius:18px;opacity:0.82;';
      wrap?.appendChild(_flowVizOverlay);
      _flowVizActive = true;
      btnAiFlowViz?.classList.add('is-active-tool');
      _showAiToast('Motion vectors active — seek frame-by-frame', true);
    } catch(e) { _showAiToast('Flow viz failed — check network'); }
    finally { _setDetecting(false); }
  };

  const _runFlowVizFrame = async () => {
    if (!_flowVizActive || !_flowVizOverlay || !_flowPrevCanvas) return;
    const fw = logicalW || video?.videoWidth || 1;
    const fh = logicalH || video?.videoHeight || 1;
    const currCanvas = new OffscreenCanvas(fw, fh);
    currCanvas.getContext('2d').drawImage(video || baseMedia, 0, 0, fw, fh);
    try {
      const { estimateFlow, flowAt, RAFT_W, RAFT_H } = await import(chrome.runtime.getURL('scripts/smart/raftFlow.js'));
      const flow = await estimateFlow(_flowPrevCanvas, currCanvas);
      _flowVizOverlay.width  = fw;
      _flowVizOverlay.height = fh;
      const ctx = _flowVizOverlay.getContext('2d');
      ctx.clearRect(0, 0, fw, fh);
      // Draw flow arrows on a sparse grid (every 28px)
      const GRID = 28;
      const SCALE = 3.5; // amplify small motions
      for (let y = GRID; y < fh - GRID/2; y += GRID) {
        for (let x = GRID; x < fw - GRID/2; x += GRID) {
          const f = flowAt(flow, x, y, fw, fh);
          const mag = Math.hypot(f.u, f.v);
          if (mag < 0.3) continue; // skip near-zero
          const nx = x + f.u * SCALE, ny = y + f.v * SCALE;
          // Color by magnitude: blue=slow, cyan=medium, yellow=fast, red=very fast
          const hue = Math.max(0, 240 - mag * 20);
          const alpha = Math.min(0.9, 0.3 + mag * 0.07);
          ctx.strokeStyle = `hsla(${hue},90%,62%,${alpha})`;
          ctx.fillStyle   = `hsla(${hue},90%,62%,${alpha})`;
          ctx.lineWidth   = 1.2;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
          // Arrowhead
          const ang = Math.atan2(ny - y, nx - x);
          const hs  = Math.min(5, mag);
          ctx.beginPath();
          ctx.moveTo(nx, ny);
          ctx.lineTo(nx - hs * Math.cos(ang - 0.45), ny - hs * Math.sin(ang - 0.45));
          ctx.lineTo(nx - hs * Math.cos(ang + 0.45), ny - hs * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
        }
      }
    } catch {}
    _flowPrevCanvas = currCanvas;
  };

  // ── Velocity HUD — live speed badge on tracked shapes ──────────────────────
  let _velHudActive  = false;
  let _velHudOverlay = null;
  let _velHist       = {};  // shapeId → [{frame, x, y}]
  const VEL_HUD_HIST = 4;

  const _aiVelocityHud = () => {
    if (_velHudActive) {
      _velHudActive = false; _velHist = {};
      if (_velHudOverlay) { _velHudOverlay.remove(); _velHudOverlay = null; }
      btnAiVelocityHud?.classList.remove('is-active-tool');
      _showAiToast('Velocity HUD off');
      return;
    }
    _velHudOverlay = document.createElement('canvas');
    _velHudOverlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:7;border-radius:18px;';
    wrap?.appendChild(_velHudOverlay);
    _velHudActive = true;
    btnAiVelocityHud?.classList.add('is-active-tool');
    _showAiToast('Velocity HUD on — shows speed/direction on tracked shapes', true);
  };

  const _runVelocityHudFrame = () => {
    if (!_velHudOverlay || !objects.length) return;
    _velHudOverlay.width  = logicalW;
    _velHudOverlay.height = logicalH;
    const ctx = _velHudOverlay.getContext('2d');
    ctx.clearRect(0, 0, logicalW, logicalH);
    const cf = currentFrameRef();
    objects.forEach(o => {
      if (o.kind !== 'rect' && o.kind !== 'ellipse') return;
      const vis = o.keyframes?.length ? _interpShape(o, cf) : o;
      const cx  = (vis.x1 + vis.x2) / 2, cy = (vis.y1 + vis.y2) / 2;
      // Accumulate position history
      if (!_velHist[o.id]) _velHist[o.id] = [];
      const hist = _velHist[o.id];
      hist.push({ frame: cf, x: cx, y: cy });
      while (hist.length > VEL_HUD_HIST) hist.shift();
      if (hist.length < 2) return;
      // Velocity = average displacement over last N frames
      const first = hist[0], last = hist[hist.length - 1];
      const dFrames = Math.max(1, last.frame - first.frame);
      const vx = (last.x - first.x) / dFrames;
      const vy = (last.y - first.y) / dFrames;
      const speed = Math.hypot(vx, vy);
      if (speed < 0.2) return;
      const angle  = Math.atan2(vy, vx) * 180 / Math.PI;
      const hue    = Math.max(0, 120 - speed * 8); // green=slow, yellow=med, red=fast
      const label  = `${speed.toFixed(1)}px/f`;
      const dir    = _compassDir(angle);
      // Arrow from centre in velocity direction
      const arLen = Math.min(40, speed * 4);
      const ex    = cx + vx / speed * arLen, ey = cy + vy / speed * arLen;
      ctx.strokeStyle = `hsl(${hue},90%,60%)`;
      ctx.fillStyle   = `hsl(${hue},90%,60%)`;
      ctx.lineWidth   = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
      const ang = Math.atan2(vy, vx);
      ctx.beginPath(); ctx.moveTo(ex, ey);
      ctx.lineTo(ex - 7*Math.cos(ang-0.4), ey - 7*Math.sin(ang-0.4));
      ctx.lineTo(ex - 7*Math.cos(ang+0.4), ey - 7*Math.sin(ang+0.4));
      ctx.closePath(); ctx.fill();
      // Speed + direction pill
      ctx.fillStyle = `hsla(${hue},70%,12%,0.80)`;
      const pill = `${label} ${dir}`;
      ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center';
      const pw = ctx.measureText(pill).width + 10;
      ctx.beginPath(); ctx.roundRect?.(cx - pw/2, cy - 24, pw, 14, 3); ctx.fill();
      ctx.fillStyle = `hsl(${hue},90%,72%)`;
      ctx.fillText(pill, cx, cy - 13);
    });
  };

  // ── Object Flow Overlay — dense LK vectors inside tracked bounding boxes ──────
  // LK is computed at 320×180 (GPU readback on a tiny surface = fast).
  // A setTimeout at ~12fps drives updates — no unthrottled RAF, no freeze.
  // Every grid point draws a minimum 3.5px tick so the overlay is always visible.
  const _OF_W = 320, _OF_H = 180;   // downscale for LK (cheap getImageData)
  const _OF_FPS_MS = 83;            // ~12fps cap

  let _objFlowActive   = false;
  let _objFlowOverlay  = null;
  let _objFlowPrevData = null;   // {data: Uint8ClampedArray, w:320, h:180}
  let _objFlowTimerId  = null;
  let _objFlowLastTime = -1;

  // Reusable small OffscreenCanvas pair (avoids GC churn)
  const _ofOC = new OffscreenCanvas(_OF_W, _OF_H);
  const _ofCtx = _ofOC.getContext('2d', { willReadFrequently: true });

  const _ofCapture = () => {
    _ofCtx.drawImage(video || baseMedia, 0, 0, _OF_W, _OF_H);
    return _ofCtx.getImageData(0, 0, _OF_W, _OF_H).data;
  };

  const _aiObjFlowViz = () => {
    if (_objFlowActive) {
      _objFlowActive = false;
      if (_objFlowTimerId) { clearTimeout(_objFlowTimerId); _objFlowTimerId = null; }
      if (_objFlowOverlay) { _objFlowOverlay.remove(); _objFlowOverlay = null; }
      _objFlowPrevData = null;
      btnAiObjFlowViz?.classList.remove('is-active-tool');
      _showAiToast('Object flow hidden');
      return;
    }
    _objFlowPrevData = { data: _ofCapture(), w: _OF_W, h: _OF_H };
    _objFlowOverlay  = document.createElement('canvas');
    _objFlowOverlay.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:8;border-radius:18px;';
    wrap?.appendChild(_objFlowOverlay);
    _objFlowActive   = true;
    _objFlowLastTime = video?.currentTime ?? -1;

    // Throttled poll at ~12fps — cheap since it bails early when frame unchanged
    const _poll = () => {
      if (!_objFlowActive) return;
      const t = video?.currentTime ?? 0;
      if (t !== _objFlowLastTime) { _runObjFlowFrame(); _objFlowLastTime = t; }
      _objFlowTimerId = setTimeout(_poll, _OF_FPS_MS);
    };
    _objFlowTimerId = setTimeout(_poll, _OF_FPS_MS);
    btnAiObjFlowViz?.classList.add('is-active-tool');
    _showAiToast('Object flow active — play or step through frames', true);
  };

  const _runObjFlowFrame = () => {
    if (!_objFlowActive || !_objFlowOverlay || !_objFlowPrevData) return;
    // Capture current at 320×180
    const currData = _ofCapture();
    const prev     = _objFlowPrevData.data;
    const W = _OF_W, H = _OF_H;

    // Luma lookup in the 320×180 buffer
    const _lum = (d, x, y) => {
      const cx = Math.max(0, Math.min(W-1, x|0)), cy = Math.max(0, Math.min(H-1, y|0));
      const i = (cy * W + cx) * 4;
      return 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    };
    // 5×5 LK (fast: 25 ops per point)
    const _lkAt = (px, py) => {
      const x = Math.max(2, Math.min(W-3, px|0)), y = Math.max(2, Math.min(H-3, py|0));
      let Ixx=0,Iyy=0,Ixy=0,Ixt=0,Iyt=0;
      for (let wy=-2; wy<=2; wy++) {
        for (let wx=-2; wx<=2; wx++) {
          const nx=Math.max(0,Math.min(W-1,x+wx)), ny=Math.max(0,Math.min(H-1,y+wy));
          const Ix=(_lum(prev,nx+1,ny)-_lum(prev,nx-1,ny))*0.5;
          const Iy=(_lum(prev,nx,ny+1)-_lum(prev,nx,ny-1))*0.5;
          const It=_lum(currData,nx,ny)-_lum(prev,nx,ny);
          Ixx+=Ix*Ix; Iyy+=Iy*Iy; Ixy+=Ix*Iy; Ixt+=Ix*It; Iyt+=Iy*It;
        }
      }
      const det=Ixx*Iyy-Ixy*Ixy;
      if (Math.abs(det)<0.25) return [0,0];
      return [Math.max(-16,Math.min(16,-(Iyy*Ixt-Ixy*Iyt)/det)),
              Math.max(-16,Math.min(16,-(Ixx*Iyt-Ixy*Ixt)/det))];
    };

    // Draw onto the display canvas at full logical resolution
    const fw = logicalW || video?.videoWidth || 1;
    const fh = logicalH || video?.videoHeight || 1;
    _objFlowOverlay.width  = fw;
    _objFlowOverlay.height = fh;
    const ctx = _objFlowOverlay.getContext('2d');
    ctx.clearRect(0, 0, fw, fh);

    // Scale: 320×180 → display
    const scX = fw / _OF_W, scY = fh / _OF_H;

    // Grid in flow-space (8px → display = 8×scX px)
    const FGRID  = 8;
    const SCALE  = 3.5;
    const MINLEN = 3.5;
    const cf = currentFrameRef();

    for (const o of objects) {
      if (o.kind !== 'rect' && o.kind !== 'ellipse') continue;
      const vis = o.keyframes?.length ? _interpShape(o, cf) : o;
      if (!vis) continue;
      const bx1 = Math.max(0, vis.x1), by1 = Math.max(0, vis.y1);
      const bx2 = Math.min(fw, vis.x2), by2 = Math.min(fh, vis.y2);
      if (bx2-bx1 < 4 || by2-by1 < 4) continue;

      // Green bbox
      ctx.strokeStyle = '#30dc30';
      ctx.lineWidth   = 1.8;
      ctx.setLineDash([]);
      ctx.strokeRect(bx1, by1, bx2-bx1, by2-by1);

      // Bbox in flow-space coords
      const fbx1=bx1/scX, fby1=by1/scY, fbx2=bx2/scX, fby2=by2/scY;

      for (let fy=fby1+FGRID*0.5; fy<fby2; fy+=FGRID) {
        for (let fx=fbx1+FGRID*0.5; fx<fbx2; fx+=FGRID) {
          const [u, v] = _lkAt(fx, fy);
          const mag  = Math.hypot(u, v);
          const len  = Math.max(MINLEN, mag * SCALE);
          const agl  = mag > 0.12 ? Math.atan2(v, u) : -Math.PI * 0.25;
          // Back to display coords
          const dx = fx * scX, dy = fy * scY;
          const nx = dx + Math.cos(agl)*len, ny = dy + Math.sin(agl)*len;
          const alp = mag > 0.4 ? 0.88 : 0.50;
          const hs  = Math.min(4.0, len * 0.45);
          const ang = Math.atan2(ny-dy, nx-dx);
          ctx.strokeStyle = `rgba(215,42,42,${alp})`;
          ctx.fillStyle   = `rgba(215,42,42,${alp})`;
          ctx.lineWidth   = 1.2;
          ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(nx, ny); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(nx, ny);
          ctx.lineTo(nx-hs*Math.cos(ang-0.48), ny-hs*Math.sin(ang-0.48));
          ctx.lineTo(nx-hs*Math.cos(ang+0.48), ny-hs*Math.sin(ang+0.48));
          ctx.closePath(); ctx.fill();
        }
      }
    }

    _objFlowPrevData = { data: currData, w: _OF_W, h: _OF_H };
  };

  const _compassDir = (deg) => {
    const d = ((deg % 360) + 360) % 360;
    const dirs = ['→','↗','↑','↖','←','↙','↓','↘'];
    return dirs[Math.round(d / 45) % 8];
  };

  // ── Smart path re-smooth — smooth selected shape's tracked keyframes ────────
  const _aiSmoothenPath = () => {
    const sel = objects.find(o => o.id === selectedId);
    if (!sel || !sel.keyframes?.length || sel.keyframes.length < 3) {
      _showAiToast('Select a tracked shape with 3+ keyframes'); return;
    }
    const kfs = sel.keyframes.slice().sort((a, b) => a.frame - b.frame);
    // Gaussian-weighted smoothing over a 5-frame window
    const SIGMA = 1.2;
    const W     = 5;
    const gauss = Array.from({length: W}, (_, i) => {
      const x = i - Math.floor(W/2);
      return Math.exp(-x*x / (2*SIGMA*SIGMA));
    });
    const gsum = gauss.reduce((a, b) => a + b, 0);
    const smoothed = kfs.map((kf, idx) => {
      let sx1=0, sy1=0, sx2=0, sy2=0, stx=0, sty=0, wSum=0;
      for (let k = 0; k < W; k++) {
        const ni = idx + k - Math.floor(W/2);
        const src = kfs[Math.max(0, Math.min(kfs.length-1, ni))];
        const w   = gauss[k] / gsum;
        if (Number.isFinite(src.x1)) { sx1+=src.x1*w; sy1+=src.y1*w; sx2+=src.x2*w; sy2+=src.y2*w; }
        if (Number.isFinite(src.tx)) { stx+=src.tx*w; sty+=src.ty*w; }
        wSum += w;
      }
      const out = { ...kf };
      if (Number.isFinite(kf.x1)) { out.x1=sx1/wSum; out.y1=sy1/wSum; out.x2=sx2/wSum; out.y2=sy2/wSum; }
      if (Number.isFinite(kf.tx)) { out.tx=stx/wSum; out.ty=sty/wSum; }
      return out;
    });
    sel.keyframes = smoothed;
    pushState(); render(true);
    _showAiToast(`Path smoothed (${smoothed.length} keyframes, σ=${SIGMA})`, true);
  };

  // ── Auto-suggest when user finishes drawing a new shape ─────────────────────
  // Runs in background after a short debounce so it doesn't block the draw commit.
  let _autoSuggestTimer = null;
  const _triggerAutoSuggest = (shapeId) => {
    clearTimeout(_autoSuggestTimer);
    _autoSuggestTimer = setTimeout(async () => {
      const shape = objects.find(o => o.id === shapeId);
      if (!shape || (shape.kind !== 'rect' && shape.kind !== 'ellipse')) return;
      // Only auto-suggest if note type and note text are both empty
      const ntv = ntSel?.value || '';
      const noteEmpty = !noteInp?.value?.trim();
      if (!noteEmpty && ntv) return;
      try {
        // Use pixel-level fast check first (< 1ms), then neural if ambiguous
        const srcW = video ? (video.videoWidth || logicalW) : (baseMedia?.naturalWidth || logicalW);
        const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
        const scX = srcW / Math.max(1, logicalW), scY = srcH / Math.max(1, logicalH);
        const rx = Math.min(shape.x1, shape.x2)*scX, ry = Math.min(shape.y1, shape.y2)*scY;
        const rw = Math.abs(shape.x2-shape.x1)*scX, rh = Math.abs(shape.y2-shape.y1)*scY;
        const SNAP = 96;
        const oc = _makeOffscreen(SNAP, SNAP);
        oc.getContext('2d').drawImage(baseMedia, rx, ry, Math.max(1, rw), Math.max(1, rh), 0, 0, SNAP, SNAP);
        const { data } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
        let skinPx = 0, greenPx = 0, brightPx = 0, gradSum = 0;
        for (let i = 0; i < SNAP*SNAP; i++) {
          const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
          const Y = 0.299*r + 0.587*g + 0.114*b;
          const Cb = -0.169*r-0.331*g+0.500*b+128, Cr = 0.500*r-0.419*g-0.081*b+128;
          if (Y>30 && Cb>=77 && Cb<=127 && Cr>=133 && Cr<=173) skinPx++;
          if (g>90 && g>r*1.35 && g>b*1.35 && g-Math.max(r,b)>35) greenPx++;
          if (Y > 200) brightPx++;
          if (i % SNAP < SNAP-1) {
            const lumR = 0.299*data[(i+1)*4]+0.587*data[(i+1)*4+1]+0.114*data[(i+1)*4+2];
            gradSum += Math.abs(Y - lumR);
          }
        }
        const tot = SNAP*SNAP;
        let suggestion = null;
        if (skinPx/tot > 0.22)   suggestion = 'Face';
        else if (greenPx/tot > 0.22) suggestion = 'Green Screen';
        else if (brightPx/tot > 0.45) suggestion = 'Screen Comp';
        else if (gradSum/tot > 12)    suggestion = 'Text Removal';
        if (suggestion) {
          _showAiToast(`Auto-detected: ${suggestion} — Suggest button for full analysis`, true);
          // Auto-fill note only if completely empty
          if (noteEmpty && noteInp) {
            noteInp.value = _aiSmartSuggestNote?.(suggestion) || '';
            noteInp.dispatchEvent(new Event('input'));
          }
        }
      } catch {}
    }, 400);
  };

  // CSS padding on the stage is static — cache it to avoid getComputedStyle on every fit().
  let _stagePad = null;
  const _getStagePad = () => {
    if (_stagePad) return _stagePad;
    const style = getComputedStyle(stage);
    _stagePad = {
      l: parseFloat(style.paddingLeft)   || 0,
      r: parseFloat(style.paddingRight)  || 0,
      t: parseFloat(style.paddingTop)    || 0,
      b: parseFloat(style.paddingBottom) || 0,
    };
    return _stagePad;
  };

  const fit = ()=>{
    try{
      const rect  = stage.getBoundingClientRect();
      // Guard: stage not yet in DOM or zero-sized — skip to avoid spurious resize.
      if (!rect.width || !rect.height) return;
      const { l: padL, r: padR, t: padT, b: padB } = _getStagePad();
      const maxW  = Math.max(100, rect.width  - padL - padR);
      const maxH  = Math.max(100, rect.height - padT - padB);
      const { width: iw, height: ih } = getMediaIntrinsicSize();
      const ar = iw/ih;
      let w = maxW;
      let h = w / ar;
      if (nativeResolution){
        w = iw;
        h = ih;
        // Safety clamp to avoid huge canvases on very large media (8K+)
        const MAX = 4096;
        const m = Math.max(w, h);
        if (m > MAX){
          const s = MAX / m;
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
      }
      if (h > maxH){ h = maxH; w = h * ar; }
      const prevW = logicalW || lastFitW || w;
      const prevH = logicalH || lastFitH || h;

      // Only update CSS/DOM when the computed size actually changed (>0.5px threshold).
      // Setting style.width/height on a <video> even to the same value forces
      // re-composition of the video texture, causing a one-frame blank flash.
      const layoutChanged = Math.abs(w - prevW) > 0.5 || Math.abs(h - prevH) > 0.5
                         || !logicalW || !logicalH;
      if (layoutChanged) {
        wrap.style.width = w + 'px';
        wrap.style.height = h + 'px';
        if (baseMedia) {
          baseMedia.style.width = w + 'px';
          baseMedia.style.height = h + 'px';
        }
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      logicalW = w;
      logicalH = h;
      lastFitW = w;
      lastFitH = h;
      const dpr = window.devicePixelRatio || 1;
      const newCW = Math.round(w * dpr);
      const newCH = Math.round(h * dpr);
      // Only reassign canvas backing buffer when dimensions changed — assigning
      // even the same value erases the canvas, causing a blank flash before render().
      const canvasSizeChanged = canvas.width !== newCW || canvas.height !== newCH;
      if (canvasSizeChanged) {
        canvas.width  = newCW;
        canvas.height = newCH;
      }
      const ctx = ctx2d();
      if (ctx){ ctx.setTransform(dpr,0,0,dpr,0,0); }
      const sx = (prevW && w) ? (w/prevW) : 1;
      const sy = (prevH && h) ? (h/prevH) : 1;
      if (objects.length && (Math.abs(sx-1) > 1e-6 || Math.abs(sy-1) > 1e-6)){
        const scalePoint = (p)=>{ p.x*=sx; p.y*=sy; };
        const scaleTrackBase = (base, kind)=>{
          if (!base) return;
          if (kind === 'stroke' || kind === 'erase') {
            (base.points || []).forEach(scalePoint);
            return;
          }
          if (kind === 'rect' || kind === 'ellipse' || kind === 'arrow') {
            if (Number.isFinite(base.x1)) base.x1 *= sx;
            if (Number.isFinite(base.y1)) base.y1 *= sy;
            if (Number.isFinite(base.x2)) base.x2 *= sx;
            if (Number.isFinite(base.y2)) base.y2 *= sy;
            return;
          }
          if (kind === 'text') {
            if (Number.isFinite(base.x)) base.x *= sx;
            if (Number.isFinite(base.y)) base.y *= sy;
          }
        };
        objects.forEach(o=>{
          if (o.kind==='stroke' || o.kind==='erase') (o.points||[]).forEach(scalePoint);
          else if (o.kind==='rect' || o.kind==='ellipse' || o.kind==='arrow'){
            o.x1*=sx; o.y1*=sy; o.x2*=sx; o.y2*=sy;
          } else if (o.kind==='text'){
            o.x*=sx; o.y*=sy;
          }
          scaleTrackBase(o.trackBase, o.kind);
          if (Array.isArray(o.keyframes)) {
            o.keyframes.forEach(kf => {
              if (Number.isFinite(kf.x1)) kf.x1 *= sx;
              if (Number.isFinite(kf.y1)) kf.y1 *= sy;
              if (Number.isFinite(kf.x2)) kf.x2 *= sx;
              if (Number.isFinite(kf.y2)) kf.y2 *= sy;
              if (Number.isFinite(kf.tx)) kf.tx *= sx;
              if (Number.isFinite(kf.ty)) kf.ty *= sy;
            });
          }
        });
      }
      if (!states.length){ pushState(); }
      render(true);
    }catch{}
  };

  const getLocalPoint = (ev)=>{
    const r = canvas.getBoundingClientRect();
    const lw = logicalW || r.width || 1;
    const lh = logicalH || r.height || 1;
    let x = (ev.clientX - r.left) * (lw / (r.width || 1));
    let y = (ev.clientY - r.top) * (lh / (r.height || 1));
    x = Math.max(0, Math.min(lw, x));
    y = Math.max(0, Math.min(lh, y));
    return { x, y };
  };

  const handleHit = (x,y, hx,hy, rad)=> (Math.hypot(x-hx,y-hy) <= rad);

  const hitTest = (p)=>{
    const x=p.x, y=p.y;
    const rad = 10;
    const frameNow = currentFrameRef();
    if (selectedId){
      const src = objects.find(s=>s.id===selectedId);
      const o = src && src.keyframes?.length ? _interpShape(src, frameNow) : src;
      if (o){
        const bb = bboxOf(o, ctx2d());
        if (o.kind==='rect' || o.kind==='ellipse'){
          const handles = [
            {h:'nw', x:bb.minX, y:bb.minY},
            {h:'ne', x:bb.maxX, y:bb.minY},
            {h:'sw', x:bb.minX, y:bb.maxY},
            {h:'se', x:bb.maxX, y:bb.maxY},
          ];
          for (const hh of handles){ if (handleHit(x,y,hh.x,hh.y,rad)) return { id:o.id, part:hh.h }; }
        }
        if (o.kind==='arrow'){
          if (handleHit(x,y,o.x1,o.y1,rad)) return { id:o.id, part:'end1' };
          if (handleHit(x,y,o.x2,o.y2,rad)) return { id:o.id, part:'end2' };
        }
      }
    }
    for (let i=objects.length-1;i>=0;i--){
      const src = objects[i];
      const o = src && src.keyframes?.length ? _interpShape(src, frameNow) : src;
      const tol = Math.max(8, (o.style?.width ?? width) + 6);
      if (o.kind==='rect'){
        const mnx=Math.min(o.x1,o.x2), mny=Math.min(o.y1,o.y2);
        const mxx=Math.max(o.x1,o.x2), mxy=Math.max(o.y1,o.y2);
        const near = (
          (x>=mnx-tol && x<=mxx+tol && (Math.abs(y-mny)<=tol || Math.abs(y-mxy)<=tol)) ||
          (y>=mny-tol && y<=mxy+tol && (Math.abs(x-mnx)<=tol || Math.abs(x-mxx)<=tol))
        );
        if (near) return { id:o.id, part:'body' };
      } else if (o.kind==='ellipse'){
        const cx=(o.x1+o.x2)/2, cy=(o.y1+o.y2)/2;
        const rx=Math.max(1,Math.abs(o.x2-o.x1)/2), ry=Math.max(1,Math.abs(o.y2-o.y1)/2);
        const nx = (x-cx)/rx, ny=(y-cy)/ry;
        const d = Math.abs((nx*nx + ny*ny) - 1);
        const approxTol = Math.max(0.12, tol / Math.max(rx,ry));
        if (d <= approxTol) return { id:o.id, part:'body' };
      } else if (o.kind==='arrow'){
        if (distToSeg(x,y,o.x1,o.y1,o.x2,o.y2) <= tol) return { id:o.id, part:'body' };
      } else if (o.kind==='stroke' || o.kind==='erase'){
        const pts = Array.isArray(o.points) ? o.points : [];
        for (let j=1;j<pts.length;j++){
          if (distToSeg(x,y,pts[j-1].x,pts[j-1].y,pts[j].x,pts[j].y) <= tol) return { id:o.id, part:'body' };
        }
      } else if (o.kind==='text'){
        const bb = bboxOf(o, ctx2d());
        if (x>=bb.minX && x<=bb.maxX && y>=bb.minY && y<=bb.maxY) return { id:o.id, part:'body' };
      }
    }
    return null;
  };

  const beginPan = (ev)=>{
    panning = true;
    panStartX = ev.clientX;
    panStartY = ev.clientY;
    panScrollL = stage.scrollLeft;
    panScrollT = stage.scrollTop;
  };

  const onDown = (ev)=>{
    try{
      if (ev.button !== 0) return;
      try{
        activePointerId = ev.pointerId;
        if (activePointerId != null && canvas.setPointerCapture) canvas.setPointerCapture(activePointerId);
      }catch{}
      if (spaceDown){ beginPan(ev); return; }
      const p = getLocalPoint(ev);
      dragging = false;
      drawing = false;
      draft = null;
      if (tool === 'move'){
        const hit = hitTest(p);
        if (!hit){ selectedId = null; render(true); updateTrackBtnState(); return; }
        selectedId = hit.id;
        dragFrame = currentFrameRef();
        // If the selected shape already has metadata, reflect it into the controls so the user
        // can edit Type/Scope after drawing.
        try{
          const o = objects.find(s=>s && s.id===selectedId);
          if (o && o.meta && (String(o.meta.g||'').trim() || String(o.meta.t||'').trim() || String(o.meta.sow||'').trim() || (Array.isArray(o.meta.sowList) && o.meta.sowList.length))){
            __setUiFromShapeMeta(o.meta);
          }
          // Reflect style into controls so users can adjust color/width/opacity after drawing.
          if (o && o.style){
            __setUiFromStyle(o.style);
          }
        }catch{}
        updateTrackBtnState();
        dragStart = {x:p.x,y:p.y};
        const o = objects.find(s=>s.id===selectedId);
        dragOrig = o ? deepClone((o.keyframes?.length ? _interpShape(o, dragFrame) : o)) : null;
        dragMode = (hit.part==='nw'||hit.part==='ne'||hit.part==='sw'||hit.part==='se') ? 'resize' : (hit.part==='end1'||hit.part==='end2') ? hit.part : 'move';
        dragHandle = hit.part;
        dragging = true;
        render(true);
        return;
      }
      const meta = readMeta();
      const style = { color, width, opacity };
      if (tool === 'text'){
        const fSize = Math.max(14, width * 4);
        // Release pointer capture immediately — we don't need it for text placement,
        // and holding it causes the blur event to fire on the textarea right after focus.
        try{ if (activePointerId != null && canvas.releasePointerCapture) canvas.releasePointerCapture(activePointerId); }catch{}
        activePointerId = null;
        showInlineTextEditor(p.x, p.y, '', fSize, (txt)=>{
          if (txt && txt.trim()){
            objects.push({ id: genId(), kind:'text', x:p.x, y:p.y, text: txt.trim(), fontSize: fSize, style, meta, frameIn: _getDefaultFrameIn(), frameOut: _getDefaultFrameOut(), keyframes: [] });
            pushState();
            render(true);
          }
        });
        return;
      }
      drawing = true;
      if (tool === 'pen' || tool === 'highlighter'){
        draft = { id: genId(), kind:'stroke', mode: tool, points:[{x:p.x,y:p.y}], style, meta };
      } else if (tool === 'eraser'){
        draft = { id: genId(), kind:'erase', points:[{x:p.x,y:p.y}], style: { ...style, width: Math.max(10, width*3), opacity: 1 }, meta:null };
      } else if (tool === 'rect'){
        draft = { id: genId(), kind:'rect', x1:p.x, y1:p.y, x2:p.x, y2:p.y, style, meta };
      } else if (tool === 'circle'){
        draft = { id: genId(), kind:'ellipse', x1:p.x, y1:p.y, x2:p.x, y2:p.y, style, meta };
      } else if (tool === 'arrow'){
        draft = { id: genId(), kind:'arrow', x1:p.x, y1:p.y, x2:p.x, y2:p.y, style, meta };
      }
      render(true);
    }catch{}
  };

  const onMove = (ev)=>{
    try{
      if (panning){
        stage.scrollLeft = panScrollL - (ev.clientX - panStartX);
        stage.scrollTop = panScrollT - (ev.clientY - panStartY);
        return;
      }
      const p = getLocalPoint(ev);
      if (dragging && tool === 'move' && selectedId && dragOrig){
        const dx = p.x - dragStart.x;
        const dy = p.y - dragStart.y;
        const idx = objects.findIndex(s=>s.id===selectedId);
        if (idx < 0) return;
        const o = objects[idx];
        if (dragMode === 'move'){
          const moved = _shiftShapeGeometry(dragOrig, dx, dy);
          _writeTrackedEditAtFrame(o, moved, dragFrame, 'move');
        } else if (dragMode === 'resize' && (o.kind==='rect' || o.kind==='ellipse')){
          let x1 = dragOrig.x1, y1 = dragOrig.y1, x2 = dragOrig.x2, y2 = dragOrig.y2;
          if (dragHandle==='nw'){ x1 = dragOrig.x1 + dx; y1 = dragOrig.y1 + dy; }
          if (dragHandle==='ne'){ x2 = dragOrig.x2 + dx; y1 = dragOrig.y1 + dy; }
          if (dragHandle==='sw'){ x1 = dragOrig.x1 + dx; y2 = dragOrig.y2 + dy; }
          if (dragHandle==='se'){ x2 = dragOrig.x2 + dx; y2 = dragOrig.y2 + dy; }
          if (ev.shiftKey){
            const w = Math.abs(x2-x1);
            const h = Math.abs(y2-y1);
            const m = Math.max(w,h);
            x2 = x1 + Math.sign(x2-x1||1)*m;
            y2 = y1 + Math.sign(y2-y1||1)*m;
          }
          _writeTrackedEditAtFrame(o, { ...dragOrig, x1, y1, x2, y2 }, dragFrame, 'reshape');
        } else if ((dragMode==='end1' || dragMode==='end2') && o.kind==='arrow'){
          const nextArrow = { ...dragOrig };
          if (dragMode==='end1'){ nextArrow.x1 = dragOrig.x1 + dx; nextArrow.y1 = dragOrig.y1 + dy; }
          if (dragMode==='end2'){ nextArrow.x2 = dragOrig.x2 + dx; nextArrow.y2 = dragOrig.y2 + dy; }
          if (ev.shiftKey){
            const ax = nextArrow.x2 - nextArrow.x1;
            const ay = nextArrow.y2 - nextArrow.y1;
            const dist = Math.hypot(ax,ay);
            const ang = Math.round(Math.atan2(ay,ax)/(Math.PI/4))*(Math.PI/4);
            if (dragMode==='end2'){
              nextArrow.x2 = nextArrow.x1 + dist*Math.cos(ang);
              nextArrow.y2 = nextArrow.y1 + dist*Math.sin(ang);
            } else {
              nextArrow.x1 = nextArrow.x2 - dist*Math.cos(ang);
              nextArrow.y1 = nextArrow.y2 - dist*Math.sin(ang);
            }
          }
          _writeTrackedEditAtFrame(o, nextArrow, dragFrame, 'reshape');
        }
        render(true);
        return;
      }
      if (!drawing || !draft) return;
      if (draft.kind === 'stroke' || draft.kind === 'erase'){
        draft.points.push({x:p.x,y:p.y});
        render(true);
        return;
      }
      let x2 = p.x, y2 = p.y;
      const x1 = draft.x1, y1 = draft.y1;
      if (ev.shiftKey){
        const dx = x2-x1; const dy=y2-y1;
        if (draft.kind === 'arrow'){
          const dist = Math.sqrt(dx*dx+dy*dy);
          const ang = Math.round(Math.atan2(dy,dx) / (Math.PI/4))*(Math.PI/4);
          x2 = x1 + dist*Math.cos(ang);
          y2 = y1 + dist*Math.sin(ang);
        } else if (draft.kind === 'rect' || draft.kind === 'ellipse'){
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          x2 = x1 + (dx>=0?m:-m);
          y2 = y1 + (dy>=0?m:-m);
        }
      }
      draft.x2 = x2; draft.y2 = y2;
      render(true);
    }catch{}
  };

  const onUp = ()=>{
    try{
      if (panning){ panning = false; }
      if (dragging){
        dragging = false;
        dragMode = '';
        dragHandle = '';
        dragOrig = null;
        dragFrame = 0;
        pushState();
        render(true);
      }
      if (drawing && draft){
        const placedKind = draft.kind;
        const placedId   = draft.id;
        draft.frameIn  = _getDefaultFrameIn();
        draft.frameOut = _getDefaultFrameOut();
        draft.keyframes = [];
        if ((draft.kind === 'stroke' || draft.kind === 'erase') && Array.isArray(draft.points) && draft.points.length > 4) {
          draft.points = _dpSimplifyStroke(draft.points, draft.kind === 'erase' ? 2.0 : 1.2);
        }
        objects.push(draft);
        draft = null;
        drawing = false;
        pushState();
        // Smart: auto-switch to Move and select the placed shape so it's
        // immediately editable (resize handles, style tweaks).
        // Skip for free-draw strokes/erase — those don't have resize handles.
        if (placedKind !== 'stroke' && placedKind !== 'erase'){
          selectedId = placedId;
          setTool('move'); // also calls render(true)
          // Auto-suggest note type from the region under the newly placed shape.
          // Only runs if no note type is already set on the shape.
          try {
            const placed = objects[objects.length - 1];
            if (placed && !placed.meta?.g && !placed.meta?.t && baseMedia &&
                (placed.kind === 'rect' || placed.kind === 'ellipse')) {
              const SNAP = 80;
              const rx = Math.min(placed.x1, placed.x2), ry = Math.min(placed.y1, placed.y2);
              const rw = Math.max(1, Math.abs(placed.x2 - placed.x1));
              const rh = Math.max(1, Math.abs(placed.y2 - placed.y1));
              const srcW = video ? (video.videoWidth || logicalW) : (baseMedia?.naturalWidth || logicalW);
              const srcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
              const scX = srcW / logicalW, scY = srcH / logicalH;
              const oc = _makeOffscreen(SNAP, SNAP);
              oc.getContext('2d').drawImage(baseMedia, rx*scX, ry*scY, rw*scX, rh*scY, 0, 0, SNAP, SNAP);
              const { data: sd } = oc.getContext('2d',{willReadFrequently:true}).getImageData(0, 0, SNAP, SNAP);
              let skinPx = 0, gradSum = 0, lumSum = 0;
              for (let si = 0; si < SNAP * SNAP; si++) {
                const r = sd[si*4], g = sd[si*4+1], b = sd[si*4+2];
                const Y  =  0.299*r + 0.587*g + 0.114*b;
                const Cb = -0.169*r - 0.331*g + 0.500*b + 128;
                const Cr =  0.500*r - 0.419*g - 0.081*b + 128;
                if (Y > 30 && Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173) skinPx++;
                lumSum += Y;
                if (si % SNAP < SNAP - 1) {
                  const lumR = 0.299*sd[si*4+4] + 0.587*sd[si*4+5] + 0.114*sd[si*4+6];
                  gradSum += Math.abs(lumR - Y);
                }
              }
              let suggestion = null;
              if (skinPx / (SNAP*SNAP) > 0.22) suggestion = 'Face';
              else if (gradSum / (SNAP*SNAP) > 12) suggestion = 'Text Removal';
              else if (lumSum / (SNAP*SNAP) > 200) suggestion = 'Screen Comp';
              if (suggestion) {
                _showAiToast(`Suggested: ${suggestion} — press 1/2/3 to set type`, false);
                if (ntSel) {
                  const opts = Array.from(ntSel.options);
                  const match = opts.find(o => { const p = (o.value||'').split('|'); return p[1] === suggestion || p[0] === suggestion; });
                  if (match) { ntSel.value = match.value; ntSel.dispatchEvent(new Event('change')); }
                }
                // Snap shape to the best-overlapping detected region
                try {
                  let detRects = [];
                  if (suggestion === 'Face') detRects = _detectFacesRects();
                  else if (suggestion === 'Text Removal') detRects = _detectTextRects();
                  else if (suggestion === 'Screen Comp') detRects = _detectScreensRects();
                  if (detRects.length) {
                    const px1 = Math.min(placed.x1, placed.x2), py1 = Math.min(placed.y1, placed.y2);
                    const px2 = Math.max(placed.x1, placed.x2), py2 = Math.max(placed.y1, placed.y2);
                    let bestIoU = 0.12, bestRect = null;
                    for (const dr of detRects) {
                      const ix1 = Math.max(px1, dr.x1), iy1 = Math.max(py1, dr.y1);
                      const ix2 = Math.min(px2, dr.x2), iy2 = Math.min(py2, dr.y2);
                      if (ix2 <= ix1 || iy2 <= iy1) continue;
                      const inter = (ix2 - ix1) * (iy2 - iy1);
                      const union = (px2-px1)*(py2-py1) + (dr.x2-dr.x1)*(dr.y2-dr.y1) - inter;
                      const iou = inter / Math.max(1, union);
                      if (iou > bestIoU) { bestIoU = iou; bestRect = dr; }
                    }
                    if (bestRect) {
                      placed.x1 = bestRect.x1; placed.y1 = bestRect.y1;
                      placed.x2 = bestRect.x2; placed.y2 = bestRect.y2;
                      pushState(); render(true);
                      _showAiToast(`Snapped to detected ${suggestion}`, true);
                    }
                  }
                } catch {}
              }
            }
          } catch {}
          // Neural background auto-suggest (runs async 400ms after shape placed,
          // adds green/blue screen + sky + shadow detection on top of pixel-level pass)
          try { _triggerAutoSuggest(placedId); } catch {}
          // Capture per-shape thumbnail from current frame for timeline display
          try {
            const placed2 = objects[objects.length - 1];
            if (placed2 && baseMedia && (placed2.kind === 'rect' || placed2.kind === 'ellipse')) {
              const tx1 = Math.min(placed2.x1, placed2.x2), ty1 = Math.min(placed2.y1, placed2.y2);
              const tw0 = Math.max(1, Math.abs(placed2.x2 - placed2.x1));
              const th0 = Math.max(1, Math.abs(placed2.y2 - placed2.y1));
              const tsrcW = video ? (video.videoWidth || logicalW) : (baseMedia?.naturalWidth || logicalW);
              const tsrcH = video ? (video.videoHeight || logicalH) : (baseMedia?.naturalHeight || logicalH);
              const tscX = tsrcW / logicalW, tscY = tsrcH / logicalH;
              const TW = 48, TH = Math.max(1, Math.round(TW * th0 / tw0));
              const thumbOc = _makeOffscreen(TW, TH);
              thumbOc.getContext('2d').drawImage(baseMedia, tx1*tscX, ty1*tscY, tw0*tscX, th0*tscY, 0, 0, TW, TH);
              createImageBitmap(thumbOc).then(bmp => {
                _tlThumbCache.set(placed2.id, bmp);
                if (tlCanvas) renderTimeline();
              }).catch(() => {});
            }
          } catch {}
        } else {
          render(true);
        }
      }
    }catch{}
    drawing = false;
    try{ if (activePointerId != null && canvas.releasePointerCapture) canvas.releasePointerCapture(activePointerId); }catch{}
    activePointerId = null;
  };

  let _stageRo = null;
  const close = (reason = 'cancel')=>{
    try{ window.removeEventListener('pointermove', onMove, true); }catch{}
    try{ window.removeEventListener('pointerup', onUp, true); }catch{}
    try{ window.removeEventListener('keydown', onKey, true); }catch{}
    try{ window.removeEventListener('keyup', onKey, true); }catch{}
    try{ window.removeEventListener('resize', onResize, true); }catch{}
    try{ canvas.removeEventListener('dblclick', onDblClick); }catch{}
    try{ stage.removeEventListener('wheel', onStageWheel); }catch{}
    try{ if (video) video.pause(); }catch{}
    try{ if (__metaPushTimer) clearTimeout(__metaPushTimer); }catch{}
    try{ if (__stylePushTimer) clearTimeout(__stylePushTimer); }catch{}
    try{ if (_draftSaveTimer) clearTimeout(_draftSaveTimer); }catch{}
    // ML cleanup
    try{ if (_samClickHandler) canvas.removeEventListener('click', _samClickHandler); }catch{}
    try{ if (_depthOverlayEl) _depthOverlayEl.remove(); _depthOverlayEl = null; }catch{}
    try{ if (_planarCanvasEl) _planarCanvasEl.remove(); _planarCanvasEl = null; }catch{}
    try{ if (_depth3DOverlayEl) _depth3DOverlayEl.remove(); _depth3DOverlayEl = null; }catch{}
    try{ if (_flowVizOverlay) _flowVizOverlay.remove(); _flowVizOverlay = null; }catch{}
    try{ if (_objFlowTimerId) { clearTimeout(_objFlowTimerId); _objFlowTimerId = null; } _objFlowActive = false; }catch{}
    try{ if (_objFlowOverlay) _objFlowOverlay.remove(); _objFlowOverlay = null; }catch{}
    try{ if (_velHudOverlay) _velHudOverlay.remove(); _velHudOverlay = null; }catch{}
    try{ clearTimeout(_autoSuggestTimer); }catch{}
    try{ _disposeMLModels(); }catch{}
    try{ if (_stageRo) { _stageRo.disconnect(); _stageRo = null; } }catch{}
    try{ _tlThumbCache.forEach(b => { try { b.close(); } catch {} }); _tlThumbCache.clear(); }catch{}
    try{ backdrop.remove(); }catch{}
    // Only fire onCancel when the user cancels/closes, not after a successful commit.
    try{ if (reason !== 'done' && typeof onCancel === 'function') onCancel(); }catch{}
  };

  const renderToOffscreen = (showGuides, list, atFrame = null)=>{
    const dpr = window.devicePixelRatio || 1;
    const cf  = (atFrame != null) ? atFrame : currentFrameRef();
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    if (!octx) return null;
    octx.setTransform(dpr,0,0,dpr,0,0);
    octx.clearRect(0,0,logicalW,logicalH);
    const prevSel = selectedId;
    if (!showGuides) selectedId = null;
    (Array.isArray(list)?list:objects).forEach((o, i) => {
      const fIn  = o.frameIn  ?? 0;
      const fOut = o.frameOut ?? 99999;
      if (cf < fIn || cf > fOut) return;
      const oi = (o.keyframes && o.keyframes.length > 0) ? _interpShape(o, cf) : o;
      renderObj(octx, oi, showGuides, i);
    });
    if (!showGuides) selectedId = prevSel;
    return off;
  };

  const commit = ()=>{
    try{
      const meta = readMeta();
      // Never include the in-flight drawing shape — if commit fires (e.g. Enter key) before
      // pointerup the draft is incomplete (only x1/y1 set, or only 1 stroke point).
      const exportObjects = objects.slice();

      // If the user didn't leave a global Type/Scope selected, but the shapes contain metadata,
      // infer a reasonable default so the caller can persist something useful.
      if ((!meta.g || !meta.t) && Array.isArray(exportObjects) && exportObjects.length){
        const counts = new Map();
        exportObjects.forEach(o=>{
          const g = String(o?.meta?.g || '').trim().toLowerCase();
          const t = String(o?.meta?.t || '').trim();
          if (!g || !t) return;
          const k = `${g}|${t}`;
          counts.set(k, (counts.get(k)||0) + 1);
        });
        if (counts.size){
          const top = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1])[0][0];
          const parts = top.split('|');
          if (!meta.g) meta.g = parts[0] || '';
          if (!meta.t) meta.t = parts.slice(1).join('|') || '';
        }
      }

      if ((!meta.sow || !String(meta.sow).trim()) && Array.isArray(exportObjects) && exportObjects.length){
        const ss=[]; const seen=new Set();
        exportObjects.forEach(o=>{
          const s = String(o?.meta?.sow || '').trim();
          if (!s) return;
          const sl = __parseSowList(s);
          sl.forEach(v=>{
            const k = String(v||'').toLowerCase();
            if (!k || seen.has(k)) return;
            seen.add(k);
            ss.push(v);
          });
        });
        if (ss.length){
          meta.sowList = ss;
          meta.sow = __formatSow(ss, meta.sow);
        }
      }

      const cf = currentFrameRef();
      const annoCanvas = renderToOffscreen(false, exportObjects, cf);
      // Export all PNGs at the video's native resolution so the annotation overlay
      // and the raw frame thumbnail are always the same pixel dimensions — no scaling
      // mismatch when _pmCompositeThumb composites them.
      const nativeW = video ? (video.videoWidth  || 1920) : (baseMedia?.naturalWidth  || 1920);
      const nativeH = video ? (video.videoHeight || 1080) : (baseMedia?.naturalHeight || 1080);
      const OUT_W = Math.min(nativeW, 3840);
      const OUT_H = Math.round(OUT_W * nativeH / Math.max(1, nativeW));
      const out = document.createElement('canvas');
      out.width = OUT_W;
      out.height = OUT_H;
      const octx = out.getContext('2d');
      // Use srcDataUrl (the exact captured frame) as the base image — video.currentTime
      // may have seeked to a neighboring keyframe, which would show the wrong frame.
      // For image-only mode fall back to drawing from the img element.
      const baseUrl = (hasVideoSource && srcDataUrl) ? srcDataUrl : (() => {
        const base = document.createElement('canvas');
        base.width = OUT_W; base.height = OUT_H;
        const drawn = drawBaseMediaToCanvas(base);
        return drawn ? base.toDataURL('image/png') : (srcDataUrl || '');
      })();
      if (octx) {
        octx.clearRect(0,0,out.width,out.height);
        // frameLockEl is a pre-decoded <img src=srcDataUrl> injected at modal open time.
        // Removing it from the DOM (on first seek/play) does not destroy the decoded bitmap.
        // Using it directly avoids creating a new Image() whose async decode makes drawImage
        // silently draw nothing — which was the #1 cause of blank base frames in the composite.
        const drawnBase = (() => {
          if (frameLockEl && frameLockEl.naturalWidth > 0) {
            try { octx.drawImage(frameLockEl, 0, 0, OUT_W, OUT_H); return true; } catch {}
          }
          if (!hasVideoSource && baseMedia && baseMedia.naturalWidth > 0) {
            try { octx.drawImage(baseMedia, 0, 0, OUT_W, OUT_H); return true; } catch {}
          }
          return false;
        })();
        if (!drawnBase && baseUrl) {
          // Last-resort synchronous attempt (works if the bitmap is already cached).
          const bi = new Image(); bi.src = baseUrl;
          try { octx.drawImage(bi, 0, 0, OUT_W, OUT_H); } catch {}
        }
        if (annoCanvas) octx.drawImage(annoCanvas, 0, 0, OUT_W, OUT_H);
      }
      // Scale annotation-only layer to native resolution
      const annoOut = document.createElement('canvas');
      annoOut.width = OUT_W;
      annoOut.height = OUT_H;
      if (annoCanvas) annoOut.getContext('2d').drawImage(annoCanvas, 0, 0, OUT_W, OUT_H);
      const outUrl = out.toDataURL('image/png');
      const annoUrl = annoOut.toDataURL('image/png');
      if (typeof onDone === 'function') onDone({
        meta,
        thumbBaseDataUrl: baseUrl,
        thumbAnnoDataUrl: annoUrl,
        thumbDataUrl: outUrl,
        shapes: deepClone(exportObjects),
        logicalW: canvas.width  / (window.devicePixelRatio || 1),
        logicalH: canvas.height / (window.devicePixelRatio || 1),
      });
    }catch(e){
      // Don't silently swallow commit errors—this is the #1 reason users think "Annotate didn't save".
      try{ console.error('[Annotate] commit failed', e); }catch{}
      return;
    }
    _clearDraft();
    close('done');
  };

  // UI bindings
  if (btnClose) btnClose.addEventListener('click', ()=>close('cancel'));
  if (btnResetZoom) btnResetZoom.addEventListener('click', ()=>{ zoomScale=1.0; applyZoom(); });
  if (btnCancel) btnCancel.addEventListener('click', ()=>close('cancel'));
  if (btnDone) btnDone.addEventListener('click', commit);
  if (videoPlayBtn) videoPlayBtn.addEventListener('click', ()=>{ toggleVideoPlayback(); });
  if (videoPrevBtn) videoPrevBtn.addEventListener('click', ()=>{ _setShuttleSpeed(0); stepVideoFrame(-1); });
  if (videoNextBtn) videoNextBtn.addEventListener('click', ()=>{ _setShuttleSpeed(0); stepVideoFrame(1); });
  if (btnJumpStart) btnJumpStart.addEventListener('click', ()=>{ _setShuttleSpeed(0); jumpVideoToEdge('start'); });
  if (btnJumpEnd)   btnJumpEnd.addEventListener('click',   ()=>{ _setShuttleSpeed(0); jumpVideoToEdge('end'); });
  if (btnLoop)      btnLoop.addEventListener('click', ()=>{
    _loopPlayback = !_loopPlayback;
    btnLoop.classList.toggle('is-active', _loopPlayback);
  });
  if (btnShortcutsToggle) btnShortcutsToggle.addEventListener('click', ()=>{
    const _p = body.querySelector('.sm-anno-shortcuts-panel');
    if (_p) _p.classList.toggle('is-visible');
  });
  if (btnTrackSources) btnTrackSources.addEventListener('click', ()=>{
    if (trackSourcePanel) trackSourcePanel.hidden = !trackSourcePanel.hidden;
  });
  if (trackModeSel) trackModeSel.addEventListener('change', ()=>{
    _updateTrackCfgFromUi();
    _showAiToast(`Tracking engine: ${trackModeSel.options[trackModeSel.selectedIndex]?.textContent || trackCfg.mode}`, true);
  });
  [trackScopeSel, trackRemoteUrlInp, trackRemoteKeyInp, trackGithubUrlInp, trackCatalogUrlInp].forEach(el => {
    if (!el) return;
    const evName = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evName, ()=> _updateTrackCfgFromUi());
    if (evName !== 'change') el.addEventListener('blur', ()=> _updateTrackCfgFromUi());
  });
  if (videoRange) {
    videoRange.addEventListener('input', ()=>{
      if (!video) return;
      try { video.pause(); } catch {}
      const { startFrame } = getVideoClipBounds();
      try { setVideoFrame(startFrame + Number(videoRange.value || 0)); } catch {}
      updateVideoTransport();
    });
  }
  toolBtns.forEach(b => b.addEventListener('click', ()=> setTool(b.dataset.tool)));
  if (btnTrack) btnTrack.addEventListener('click', () => {
    if (_isTracking) { _trackingAborted = true; return; }
    const sel = objects.find(o => o.id === selectedId);
    if (sel) {
      if (String(trackCfg.mode || 'auto') === 'remote' && !String(trackCfg.remoteUrl || trackCfg.githubManifestUrl || trackCfg.apiCatalogUrl || '').trim()) {
        _showAiToast('Remote mode selected, but no API or catalog source is configured');
      }
      _trackShape(sel);
    }
  });
  if (btnTrackAll) btnTrackAll.addEventListener('click', () => {
    if (_isTracking) { _trackingAborted = true; return; }
    if (String(trackCfg.mode || 'auto') === 'remote' && !String(trackCfg.remoteUrl || trackCfg.githubManifestUrl || trackCfg.apiCatalogUrl || '').trim()) {
      _showAiToast('Remote mode selected, but no API or catalog source is configured');
    }
    _trackAllParallel();
  });
  if (btnDetectAndTrack) btnDetectAndTrack.addEventListener('click', () => { _detectAndTrackAll(); });
  if (btnAiDetectFaces)   btnAiDetectFaces.addEventListener('click',   () => _aiDetectFaces());
  if (btnAiDetectScreens) btnAiDetectScreens.addEventListener('click', () => _aiDetectScreens());
  if (btnAiDetectText)    btnAiDetectText.addEventListener('click',    () => _aiDetectText());
  if (btnAiSmartSuggest)  btnAiSmartSuggest.addEventListener('click',  () => _aiSmartSuggest());
  if (btnAiScanAll)       btnAiScanAll.addEventListener('click',       () => _aiScanAll());
  if (btnAiDetectKeys)    btnAiDetectKeys.addEventListener('click',    () => _aiDetectKeys());
  if (btnAiDetectMatte)   btnAiDetectMatte.addEventListener('click',   () => _aiDetectMatte());
  if (btnAiDetectWire)    btnAiDetectWire.addEventListener('click',    () => _aiDetectWire());
  if (btnAiEdgeSnap)      btnAiEdgeSnap.addEventListener('click',      () => _aiEdgeSnap());
  if (btnAiSamMode)       btnAiSamMode.addEventListener('click',       () => _aiSamMode());
  if (btnAiDetectML)      btnAiDetectML.addEventListener('click',      () => _aiDetectML());
  if (btnAiDepthMap)      btnAiDepthMap.addEventListener('click',      () => _aiDepthMap());
  if (btnAiPlanarTrack)   btnAiPlanarTrack.addEventListener('click',   () => _aiPlanarTrack());
  if (btnAiDepthTrack)    btnAiDepthTrack.addEventListener('click',    () => _aiDepthTrack());
  if (btnAiFlowViz)       btnAiFlowViz.addEventListener('click',       () => _aiFlowViz());
  if (btnAiObjFlowViz)    btnAiObjFlowViz.addEventListener('click',    () => _aiObjFlowViz());
  if (btnAiVelocityHud)   btnAiVelocityHud.addEventListener('click',   () => _aiVelocityHud());
  if (btnAiSmoothPath)    btnAiSmoothPath.addEventListener('click',    () => _aiSmoothenPath());
  if (btnUndo) btnUndo.addEventListener('click', doUndo);
  if (btnRedo) btnRedo.addEventListener('click', doRedo);
  if (btnClear) btnClear.addEventListener('click', ()=>{
    objects = []; draft = null; selectedId = null;
    pushState(); render(true);
  });
  // ── Smart cursor — precision SVG crosshair in active drawing color ──────────
  const _updateSmartCursor = () => {
    if (!canvas) return;
    if (tool === 'move')   { canvas.style.cursor = 'default'; return; }
    if (tool === 'eraser') { canvas.style.cursor = 'cell'; return; }
    const c = String(color || '#ffffff').replace(/#/g, '%23');
    const r = tool === 'highlighter' ? 5 : tool === 'text' ? 2 : 3;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>`
      + `<line x1='12' y1='1' x2='12' y2='9' stroke='${c}' stroke-width='1.5' stroke-linecap='round' opacity='.9'/>`
      + `<line x1='12' y1='15' x2='12' y2='23' stroke='${c}' stroke-width='1.5' stroke-linecap='round' opacity='.9'/>`
      + `<line x1='1' y1='12' x2='9' y2='12' stroke='${c}' stroke-width='1.5' stroke-linecap='round' opacity='.9'/>`
      + `<line x1='15' y1='12' x2='23' y2='12' stroke='${c}' stroke-width='1.5' stroke-linecap='round' opacity='.9'/>`
      + `<circle cx='12' cy='12' r='${r}' fill='none' stroke='${c}' stroke-width='1.5' opacity='.9'/>`
      + `</svg>`;
    canvas.style.cursor = `url("data:image/svg+xml,${svg}") 12 12, crosshair`;
  };

  const __setColor = (c)=>{
    color = String(c||DEFAULT_COLOR);
    if (colorPick) colorPick.value = color;
    if (colordisc) colordisc.style.background = color;
    if (colorbtn) colorbtn.style.setProperty('--sm-active-color', color);
    modal?.style.setProperty('--sm-draw-color', color);
    _updateSmartCursor();
    swatches.forEach(ss=>{
      const sc = String(ss.getAttribute('data-color')||'').toLowerCase();
      ss.classList.toggle('is-active', sc && sc === color.toLowerCase());
    });
  };
  if (colorPick) colorPick.addEventListener('input', ()=>{ __setColor(String(colorPick.value||DEFAULT_COLOR)); __applyUiStyleToSelectedShape(); });
  swatches.forEach(s=> s.addEventListener('click', ()=>{ const c = s.getAttribute('data-color') || DEFAULT_COLOR; __setColor(c); __applyUiStyleToSelectedShape(); }));
  woptBtns.forEach(b => b.addEventListener('click', ()=>{
    __setWidth(parseFloat(b.getAttribute('data-w')||'4')||4);
    __applyUiStyleToSelectedShape();
    if (strokepanel) strokepanel.hidden = true;
  }));
  if (opRange) opRange.addEventListener('input', ()=>{
    opacity = parseFloat(opRange.value||'1')||1;
    if (opvalEl) opvalEl.textContent = `${Math.round(opacity*100)}%`;
    __applyUiStyleToSelectedShape();
  });

  // Panel open/close — color chip and stroke chip
  const __closePanels = ()=>{
    if (colorpanel && !colorpanel.hidden) colorpanel.hidden = true;
    if (strokepanel && !strokepanel.hidden) strokepanel.hidden = true;
  };
  if (colorbtn) colorbtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const wasOpen = colorpanel && !colorpanel.hidden;
    __closePanels();
    if (!wasOpen && colorpanel) colorpanel.hidden = false;
  });
  if (strokebtn) strokebtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const wasOpen = strokepanel && !strokepanel.hidden;
    __closePanels();
    if (!wasOpen && strokepanel) strokepanel.hidden = false;
  });
  // Close panels when clicking anywhere outside the toolbar area
  backdrop.addEventListener('click', ()=>{ __closePanels(); }, true);

  // ── Inline text editor — replaces window.prompt for text tool ──────────
  // Positions a styled <textarea> directly on the canvas at logical coords.
  function showInlineTextEditor(logX, logY, initText, fontSizePx, onCommit){
    // Already editing? bail.
    if (wrap.querySelector('.sm-anno-texteditor')) return;

    const cr = canvas.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    // canvas is inset:0 inside wrap, so offsets are canvas-relative
    const scaleX = cr.width  / Math.max(1, logicalW);
    const scaleY = cr.height / Math.max(1, logicalH);

    const left = Math.round(logX * scaleX);
    const top  = Math.round(logY * scaleY);
    const fontPx = Math.max(13, Math.round((fontSizePx || Math.max(14, width * 4)) * scaleX));

    const ta = document.createElement('textarea');
    ta.className = 'sm-anno-texteditor';
    ta.value = initText || '';
    ta.style.left     = `${left}px`;
    ta.style.top      = `${top}px`;
    ta.style.fontSize = `${fontPx}px`;
    ta.style.color    = color;
    ta.rows = 1;

    const autoResize = ()=>{
      ta.style.height = 'auto';
      ta.style.height = (ta.scrollHeight) + 'px';
    };
    ta.addEventListener('input', autoResize);

    let committed = false;
    const commit = ()=>{
      if (committed) return;
      committed = true;
      try{ wrap.removeChild(ta); }catch{}
      onCommit(ta.value);
    };
    const cancel = ()=>{
      if (committed) return;
      committed = true;
      try{ wrap.removeChild(ta); }catch{}
      onCommit(null);
    };

    ta.addEventListener('keydown', (e)=>{
      e.stopPropagation();
      if (e.key === 'Escape'){ cancel(); return; }
      if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); commit(); return; }
      setTimeout(autoResize, 0);
    });
    ta.addEventListener('blur', ()=>{
      // Delay so click-away on canvas doesn't race
      setTimeout(()=>{ if (!committed && ta.parentNode === wrap) commit(); }, 80);
    });

    wrap.appendChild(ta);
    autoResize();
    // Defer focus past the current pointer-event cycle.
    // If we call focus() synchronously here (still inside pointerdown), some Chrome
    // builds fire an immediate blur when the matching pointerup lands, which collapses
    // the textarea before the user types anything.
    setTimeout(()=>{
      if (!committed && ta.parentNode === wrap){
        ta.focus();
        if (initText) ta.setSelectionRange(0, ta.value.length);
      }
    }, 0);
  }

  canvas.addEventListener('pointerdown', onDown);

  // Smart: double-click a text object to re-edit its content
  const onDblClick = (ev)=>{
    try{
      const p = getLocalPoint(ev);
      const hit = hitTest(p);
      if (!hit) return;
      const obj = objects.find(o=>o && o.id===hit.id);
      if (!obj || obj.kind !== 'text') return;
      const frameNow = currentFrameRef();
      const visibleObj = obj.keyframes?.length ? _interpShape(obj, frameNow) : obj;
      if (!visibleObj) return;
      showInlineTextEditor(visibleObj.x, visibleObj.y, obj.text || '', obj.fontSize, (txt)=>{
        if (txt !== null){
          obj.text = txt.trim() || obj.text;
          if (obj.keyframes?.length) _writeTrackedEditAtFrame(obj, visibleObj, frameNow, 'reshape');
          pushState();
          render(true);
        }
      });
    }catch{}
  };
  canvas.addEventListener('dblclick', onDblClick);

  // Smart: Ctrl/Cmd + scroll wheel → zoom
  const onStageWheel = (ev)=>{
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : (1 / 1.12);
    zoomScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomScale * factor));
    applyZoom();
  };
  stage.addEventListener('wheel', onStageWheel, { passive: false });

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);

  backdrop.addEventListener('mousedown', (ev)=>{ if (ev.target === backdrop) close('cancel'); });

  const onResize = ()=>{ fit(); };
  window.addEventListener('resize', onResize, true);

  const onKey = (e)=>{
    const k = (e.key||'').toLowerCase();
    const meta = e.metaKey || e.ctrlKey;
    const ae = document.activeElement;
    const isTyping = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    // While an inline text editor is open, pass ALL keys through — the textarea handles them.
    // (onKey fires in capture phase so we must guard here, not in the textarea listener.)
    if (isTyping && wrap.querySelector('.sm-anno-texteditor')) return;

    if (k==='escape'){ e.preventDefault(); if (_isTracking) { _trackingAborted = true; return; } close('cancel'); return; }
    if (!meta && !isTyping && video && k===' '){ e.preventDefault(); toggleVideoPlayback(); return; }
    if (!meta && !isTyping && video && k==='k'){ e.preventDefault(); _setShuttleSpeed(0); return; }
    // Commit on Enter only when not typing in a field; when typing, use Cmd/Ctrl+Enter.
    if (k==='enter' && !e.shiftKey && !isTyping){ e.preventDefault(); commit(); return; }
    if (k==='enter' && !e.shiftKey && isTyping && meta){ e.preventDefault(); commit(); return; }
    if (e.code === 'Space' && e.type === 'keydown' && !isTyping){ e.preventDefault(); spaceDown = true; return; }
    if (e.code === 'Space' && e.type === 'keyup'){ spaceDown = false; panning = false; return; }
    if (!meta && !isTyping){
      // JKL shuttle — J=reverse, L=forward, K=stop (handled above)
      if (k==='j' && video){ e.preventDefault();
        if (_shuttleSpeed >= 0) _setShuttleSpeed(-1);
        else _setShuttleSpeed(Math.max(-8, _shuttleSpeed * 2));
        return; }
      if (k==='l' && video){ e.preventDefault();
        if (_shuttleSpeed <= 0) _setShuttleSpeed(1);
        else _setShuttleSpeed(Math.min(8, _shuttleSpeed * 2));
        return; }
      if (e.key === 'ArrowLeft'){ e.preventDefault(); _setShuttleSpeed(0); stepVideoFrame(e.shiftKey ? -10 : -1); return; }
      if (e.key === 'ArrowRight'){ e.preventDefault(); _setShuttleSpeed(0); stepVideoFrame(e.shiftKey ? 10 : 1); return; }
      if (e.key === 'Home'){ e.preventDefault(); _setShuttleSpeed(0); jumpVideoToEdge('start'); return; }
      if (e.key === 'End'){ e.preventDefault(); _setShuttleSpeed(0); jumpVideoToEdge('end'); return; }
      // I/O — set selected shape frame in/out
      if (k==='i' && video){ e.preventDefault();
        const _sel = objects.find(o=>o.id===selectedId);
        if (_sel){ _sel.frameIn = currentFrameRef(); pushState(); render(true); renderTimeline(); }
        return; }
      if (k==='o'){ e.preventDefault();
        const _sel = objects.find(o=>o.id===selectedId);
        if (_sel && video){ _sel.frameOut = currentFrameRef(); pushState(); render(true); renderTimeline(); return; }
        setTool('circle'); return; }
      // Loop toggle
      if (k===','){ e.preventDefault();
        _loopPlayback = !_loopPlayback;
        if (btnLoop) btnLoop.classList.toggle('is-active', _loopPlayback);
        return; }
      // Shortcut panel
      if (e.key==='?'){ e.preventDefault();
        const _p = body.querySelector('.sm-anno-shortcuts-panel');
        if (_p) _p.classList.toggle('is-visible');
        return; }
      if (k==='v'){ e.preventDefault(); setTool('move'); return; }
      if (k==='p'){ e.preventDefault(); setTool('pen'); return; }
      if (k==='h'){ e.preventDefault(); setTool('highlighter'); return; }
      if (k==='a'){ e.preventDefault(); setTool('arrow'); return; }
      if (k==='r'){ e.preventDefault(); setTool('rect'); return; }
      if (k==='c'){ e.preventDefault(); setTool('circle'); return; }
      if (k==='t'){ e.preventDefault(); setTool('text'); return; }
      if (k==='e'){ e.preventDefault(); setTool('eraser'); return; }
    }
    if (meta && k==='z' && !e.shiftKey){ e.preventDefault(); doUndo(); return; }
    if (meta && k==='z' && e.shiftKey){ e.preventDefault(); doRedo(); return; }
    if (meta && k==='y'){ e.preventDefault(); doRedo(); return; }

    // Smart: zoom keyboard shortcuts
    if (meta && (k==='=' || k==='+')){ e.preventDefault(); zoomScale=Math.min(MAX_ZOOM,zoomScale*1.25); applyZoom(); return; }
    if (meta && k==='-'){ e.preventDefault(); zoomScale=Math.max(MIN_ZOOM,zoomScale/1.25); applyZoom(); return; }
    if (meta && k==='0'){ e.preventDefault(); zoomScale=1.0; applyZoom(); return; }

    // Smart: Cmd/Ctrl+D — duplicate selected shape with slight offset
    if (meta && k==='d' && selectedId && !isTyping){
      e.preventDefault();
      try{
        const idx = objects.findIndex(s=>s.id===selectedId);
        if (idx>=0){
          const clone = deepClone(objects[idx]);
          clone.id = genId();
          const off = 14;
          if (clone.kind==='stroke'||clone.kind==='erase'){
            (clone.points||[]).forEach(p=>{p.x+=off;p.y+=off;});
          } else if (clone.kind==='rect'||clone.kind==='ellipse'||clone.kind==='arrow'){
            clone.x1+=off; clone.y1+=off; clone.x2+=off; clone.y2+=off;
          } else if (clone.kind==='text'){
            clone.x+=off; clone.y+=off;
          }
          objects.push(clone);
          selectedId = clone.id;
          pushState(); render(true);
        }
      }catch{}
      return;
    }

    if ((k==='backspace' || k==='delete') && selectedId && !isTyping){
      e.preventDefault();
      const idx = objects.findIndex(s=>s.id===selectedId);
      if (idx>=0){ objects.splice(idx,1); selectedId=null; pushState(); render(true); }
      return;
    }

    // Smart: 1/2/3 quick-select note type group (Add / Remove / Change) + auto-color
    if (!meta && !isTyping){
      if (k==='1'){ e.preventDefault(); __selectNtGroup('add'); return; }
      if (k==='2'){ e.preventDefault(); __selectNtGroup('remove'); return; }
      if (k==='3'){ e.preventDefault(); __selectNtGroup('change'); return; }
    }
    // AI sidebar keyboard shortcuts (only when not typing and no modifier)
    if (!meta && !e.shiftKey && !isTyping && AI_KEYS[k]) {
      e.preventDefault();
      AI_KEYS[k]();
      return;
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  // init
  try{ __setUiFromStyle({ color, width, opacity }); }catch{}
  // Inject TR + BL corner bracket elements (TL + BR come from CSS ::before/::after)
  ['tr','bl'].forEach(pos => {
    const el = document.createElement('div');
    el.className = `sm-anno-corner sm-anno-corner-${pos}`;
    wrap?.appendChild(el);
  });
  // Frame locked badge — visible while the captured thumbnail overlay is pinned
  if (hasThumbnailOverlay) {
    const lockBadge = document.createElement('div');
    lockBadge.className = 'sm-anno-frame-lock-badge';
    lockBadge.innerHTML = '<span class="sm-anno-flb-dot"></span>FRAME LOCKED';
    stage?.appendChild(lockBadge);
  }
  // Center crosshair reference marker
  const centerMark = document.createElement('div');
  centerMark.className = 'sm-anno-center-mark';
  centerMark.setAttribute('aria-hidden', 'true');
  stage?.appendChild(centerMark);
  // Cursor glow ring — follows mouse on canvas in active draw color
  const cursorGlow = document.createElement('div');
  cursorGlow.className = 'sm-anno-cursor-glow';
  stage?.appendChild(cursorGlow);
  if (canvas && stage) {
    // Cache stage rect — getBoundingClientRect on every mousemove forces layout.
    // Invalidate on resize via the existing ResizeObserver (fit() is called there).
    let _stageRect = null;
    const _invalidateStagRect = () => { _stageRect = null; };
    window.addEventListener('resize', _invalidateStagRect, { passive: true });
    canvas.addEventListener('mousemove', (e) => {
      if (!_stageRect) _stageRect = stage.getBoundingClientRect();
      const lx = e.clientX - _stageRect.left;
      const ly = e.clientY - _stageRect.top;
      cursorGlow.style.transform = `translate(calc(${lx}px - 50%), calc(${ly}px - 50%)) translateZ(0)`;
      cursorGlow.style.opacity = '1';
    }, { passive: true });
    canvas.addEventListener('mouseleave', () => { cursorGlow.style.opacity = '0'; });
    canvas.addEventListener('mouseenter', () => { _stageRect = null; }); // re-measure on enter
  }
  // ── Empty state hint ──────────────────────────────────────────────────────
  const emptyHint = document.createElement('div');
  emptyHint.className = 'sm-anno-empty-hint';
  emptyHint.setAttribute('aria-hidden', 'true');
  emptyHint.innerHTML = '<span class="sm-anno-eh-icon">✦</span><span class="sm-anno-eh-text">Select a tool and draw to annotate</span>';
  stage?.appendChild(emptyHint);

  // ── Smart context strip refs ───────────────────────────────────────────────
  const ctxStrip    = stage?.querySelector('.sm-anno-ctx-strip');
  const ctxScene    = ctxStrip?.querySelector('.sm-anno-ctx-scene');
  const ctxAiHint   = ctxStrip?.querySelector('.sm-anno-ctx-ai-hint');
  const ctxSel      = ctxStrip?.querySelector('.sm-anno-ctx-sel');
  const ctxBriefBtn = ctxStrip?.querySelector('.sm-anno-ctx-brief');

  // Type → label/color map for context strip and smart color assignment
  const TYPE_META = {
    'Face':         { color:'#ff7a7a', icon:'👤' },
    'Green Screen': { color:'#2ecc71', icon:'🟢' },
    'Blue Screen':  { color:'#3498db', icon:'🔵' },
    'Screen Comp':  { color:'#2ed8ff', icon:'🖥' },
    'Text Removal': { color:'#ffd166', icon:'📝' },
    'Hard Matte':   { color:'#e67e22', icon:'▬' },
    'Sky':          { color:'#74b9ff', icon:'🌤' },
    'Shadow':       { color:'#636e72', icon:'🌑' },
    'Matte':        { color:'#b2bec3', icon:'◻' },
  };

  const _updateCtxStrip = () => {
    if (!ctxStrip) return;
    const cf    = currentFrameRef();
    const total = objects.length;
    const types = [...new Set(objects.map(o => o.meta?.t).filter(Boolean))];
    if (ctxScene) ctxScene.textContent = `${total} ann${total !== 1 ? 's' : ''}${types.length ? ' · ' + types.slice(0,3).join(' / ') : ''}`;
    const sel = selectedId ? objects.find(o => o.id === selectedId) : null;
    if (ctxAiHint) {
      const tele = sel ? _trackTelemetry.get(sel.id) : null;
      if (tele?.engine) {
        const conf = Number.isFinite(tele.confidence) ? `${Math.round(tele.confidence * 100)}%` : '';
        const profile = tele.profileLabel || '';
        const extras = tele.profileDesc ? ` · ${tele.profileDesc}` : '';
        ctxAiHint.textContent = `${tele.engine}${conf ? ` · ${conf}` : ''}${profile ? ` · ${profile}` : ''}${extras}`;
      } else if (_isTracking) {
        ctxAiHint.textContent = '✦ Tracking…';
      } else {
        ctxAiHint.textContent = '✦ AI ready';
      }
    }
    if (ctxSel) {
      if (sel) {
        const kfs   = sel.keyframes?.length || 0;
        const tin   = sel.frameIn  ?? 0;
        const tout  = sel.frameOut ?? '∞';
        const note  = (sel.meta?.n || '').slice(0, 40);
        const aiTag = (sel.meta?.t || sel.meta?.g || '').slice(0, 20);
        const tracked = kfs > 1 ? ` · ${kfs}kf` : '';
        ctxSel.textContent = `${aiTag ? aiTag + ' ·' : ''} F${tin}–${typeof tout === 'number' ? tout : tout}${tracked}${note ? ' · "' + note + '"' : ''}`;
        ctxSel.style.display = '';
      } else {
        ctxSel.style.display = 'none';
      }
    }
  };

  // ── Floating shape inspector (enhanced) ───────────────────────────────────
  const shapeInspector = document.createElement('div');
  shapeInspector.className = 'sm-anno-shape-insp';
  shapeInspector.setAttribute('aria-label', TT('Selected shape'));
  stage?.appendChild(shapeInspector);

  const SHAPE_LABELS = { pen:'Pen', arrow:'Arrow', rect:'Rect', circle:'Circle', text:'Text', highlighter:'Highlight' };
  const _updateShapeInspector = () => {
    const sel = selectedId ? objects.find(o => o.id === selectedId) : null;
    const hasShapes = objects.length > 0;
    if (emptyHint) emptyHint.style.opacity = (!hasShapes && !draft) ? '1' : '0';
    _updateCtxStrip();
    if (!sel) { shapeInspector.style.opacity = '0'; shapeInspector.style.pointerEvents = 'none'; return; }
    const c     = sel.style?.color || '#fff';
    const label = SHAPE_LABELS[sel.kind] || String(sel.kind || '');
    const kfs   = sel.keyframes?.length || 0;
    const aiTag = sel.meta?.t || sel.meta?.g || '';
    const notePrev = (sel.meta?.n || '').slice(0, 60);
    const tin   = sel.frameIn  != null ? `F${sel.frameIn}` : '—';
    const tout  = sel.frameOut != null ? `F${sel.frameOut}` : '∞';
    const aiMeta = TYPE_META[aiTag];
    shapeInspector.innerHTML = `
      <div class="sm-anno-sinsp-row">
        <span class="sm-anno-sinsp-kind">${label.toUpperCase()}</span>
        ${aiTag ? `<span class="sm-anno-sinsp-aitype" style="color:${aiMeta?.color||'#aaa'}">${aiMeta?.icon||'✦'} ${aiTag}</span>` : ''}
        <span class="sm-anno-sinsp-swatch" style="--sc:${c}"></span>
        <button class="sm-anno-sinsp-del" title="Delete (Del)">✕</button>
      </div>
      <div class="sm-anno-sinsp-meta">
        <span title="Frame range">${tin} – ${tout}</span>
        ${kfs > 1 ? `<span class="sm-anno-sinsp-tracked" title="Tracked keyframes">🎯 ${kfs} kf</span>` : ''}
        ${notePrev ? `<span class="sm-anno-sinsp-note" title="Note">"${notePrev}"</span>` : ''}
      </div>`;
    shapeInspector.querySelector('.sm-anno-sinsp-del')?.addEventListener('click', () => {
      const idx = objects.findIndex(o => o.id === selectedId);
      if (idx >= 0) { objects.splice(idx, 1); selectedId = null; pushState(); render(true); }
    });
    shapeInspector.style.opacity = '1';
    shapeInspector.style.pointerEvents = '';
  };

  // ── VFX Brief generator ────────────────────────────────────────────────────
  const _generateVfxBrief = () => {
    if (!objects.length) { _showAiToast('No annotations to summarise'); return; }
    const cf    = currentFrameRef();
    const fps   = videoFrameRate || 24;
    const tc    = (f) => {
      const s = f / fps;
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sc = Math.floor(s%60), fr = Math.round(f%fps);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}:${String(fr).padStart(2,'0')}`;
    };
    const groups = {};
    objects.forEach(o => {
      const type = o.meta?.t || o.meta?.g || 'General';
      if (!groups[type]) groups[type] = [];
      groups[type].push(o);
    });
    const lines = [
      `PostFlowX VFX Brief — ${new Date().toLocaleDateString()}`,
      `Frame: ${cf}  (${tc(cf)})  ·  Total annotations: ${objects.length}`,
      '─'.repeat(52),
      '',
    ];
    Object.entries(groups).forEach(([type, shapes]) => {
      const meta = TYPE_META[type];
      lines.push(`${meta?.icon || '▸'} ${type.toUpperCase()} (${shapes.length})`);
      shapes.forEach(s => {
        const tin  = s.frameIn  != null ? `F${s.frameIn}`  : '—';
        const tout = s.frameOut != null ? `F${s.frameOut}` : '∞';
        const kfs  = (s.keyframes?.length || 0) > 1 ? ` [tracked ${s.keyframes.length}kf]` : '';
        const note = s.meta?.n ? `  "${s.meta.n}"` : '';
        lines.push(`  ${tin}–${tout}${kfs}${note}`);
      });
      lines.push('');
    });
    lines.push(`SoW Tags: ${[...new Set(objects.map(o=>o.meta?.sow||o.meta?.t).filter(Boolean))].join(', ') || '—'}`);
    const brief = lines.join('\n');
    // Copy to clipboard and show toast
    navigator.clipboard?.writeText(brief).catch(()=>{});
    // Show in a floating overlay on the stage
    const existing = stage?.querySelector('.sm-anno-brief-overlay');
    if (existing) { existing.remove(); return; } // toggle off
    const ov = document.createElement('div');
    ov.className = 'sm-anno-brief-overlay';
    ov.innerHTML = `
      <div class="sm-anno-brief-head">
        <span>✦ VFX Brief</span>
        <button class="sm-anno-brief-copy" title="Copy to clipboard">⎘ Copy</button>
        <button class="sm-anno-brief-close">✕</button>
      </div>
      <pre class="sm-anno-brief-body">${brief.replace(/</g,'&lt;')}</pre>`;
    ov.querySelector('.sm-anno-brief-close')?.addEventListener('click', () => ov.remove());
    ov.querySelector('.sm-anno-brief-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(brief).catch(()=>{});
      _showAiToast('Brief copied to clipboard', true);
    });
    stage?.appendChild(ov);
    _showAiToast('VFX Brief generated — copied to clipboard', true);
  };
  ctxBriefBtn?.addEventListener('click', _generateVfxBrief);

  // ── Hover quick-scan tooltip ───────────────────────────────────────────────
  let _hoverTip = null, _hoverTimer = null;
  const _hoverTipEl = document.createElement('div');
  _hoverTipEl.className = 'sm-anno-hover-tip';
  _hoverTipEl.setAttribute('aria-hidden', 'true');
  stage?.appendChild(_hoverTipEl);

  canvas?.addEventListener('mousemove', (e) => {
    clearTimeout(_hoverTimer);
    if (tool !== 'move') { _hoverTipEl.style.opacity = '0'; return; }
    _hoverTimer = setTimeout(() => {
      const r = canvas.getBoundingClientRect();
      const lx = (e.clientX - r.left) / (r.width  || 1) * logicalW;
      const ly = (e.clientY - r.top)  / (r.height || 1) * logicalH;
      // Check if cursor is over a shape
      const cf = currentFrameRef();
      const hit = objects.find(o => {
        if (o.kind !== 'rect' && o.kind !== 'ellipse') return false;
        const vis = o.keyframes?.length ? _interpShape(o, cf) : o;
        return lx >= Math.min(vis.x1,vis.x2) && lx <= Math.max(vis.x1,vis.x2)
            && ly >= Math.min(vis.y1,vis.y2) && ly <= Math.max(vis.y1,vis.y2);
      });
      if (hit) {
        const aiTag = hit.meta?.t || hit.meta?.g || '';
        const kfs   = hit.keyframes?.length > 1 ? ` · ${hit.keyframes.length}kf tracked` : '';
        _hoverTipEl.textContent = `${aiTag || SHAPE_LABELS[hit.kind] || hit.kind}${kfs}`;
        _hoverTipEl.style.left    = (e.clientX - r.left + 12) + 'px';
        _hoverTipEl.style.top     = (e.clientY - r.top  - 28) + 'px';
        _hoverTipEl.style.opacity = '1';
      } else {
        _hoverTipEl.style.opacity = '0';
      }
    }, 120);
  }, { passive: true });
  canvas?.addEventListener('mouseleave', () => { clearTimeout(_hoverTimer); _hoverTipEl.style.opacity = '0'; });

  // ── Keyboard shortcuts for AI sidebar ─────────────────────────────────────
  // Registered separately from the main keydown handler to not conflict with draw keys.
  const AI_KEYS = {
    'f': () => btnAiDetectFaces?.click(),
    's': () => btnAiSamMode?.click(),
    'd': () => btnAiDetectML?.click(),
    'g': () => btnAiSmartSuggest?.click(),
    'b': () => _generateVfxBrief(),
    'w': () => btnAiFlowViz?.click(),
    'z': () => btnAiDepthMap?.click(),
    '`': () => btnAiScanAll?.click(),
    '3': () => btnAiPlanarTrack?.click(),
    '[': () => btnAiSmoothPath?.click(),
  };

  // Set initial draw color CSS var
  modal?.style.setProperty('--sm-draw-color', color || DEFAULT_COLOR);
  setTool(tool);

  // ResizeObserver: refit canvas when the stage container changes size (DPI / window move).
  // Debounce to 1 frame — without debounce, fit() resizing the wrap can re-trigger the
  // observer on the same frame, causing a resize oscillation loop.
  try {
    let _roRaf = 0;
    _stageRo = new ResizeObserver(() => {
      if (_roRaf) return; // already scheduled this frame
      _roRaf = requestAnimationFrame(() => { _roRaf = 0; try { fit(); } catch {} });
    });
    _stageRo.observe(stage);
  } catch {}

  // Restore unsaved draft if no initial shapes were provided
  if (!initialShapes || !initialShapes.length) {
    _loadDraft().then(draft => {
      try {
        if (!Array.isArray(draft) || !draft.length) return;
        const stack = head.querySelector('.sm-anno-headstack') || head;
        const banner = document.createElement('div');
        banner.className = 'sm-anno-draft-banner';
        banner.innerHTML = `<span class="sm-anno-draft-msg">Unsaved draft recovered</span>
          <button class="sm-anno-draft-restore btn mini">Restore</button>
          <button class="sm-anno-draft-discard btn mini">Discard</button>`;
        stack.prepend(banner);
        banner.querySelector('.sm-anno-draft-restore').addEventListener('click', () => {
          try { objects = deepClone(draft); pushState(); render(true); } catch {}
          banner.remove();
        });
        banner.querySelector('.sm-anno-draft-discard').addEventListener('click', () => {
          _clearDraft();
          banner.remove();
        });
      } catch {}
    }).catch(() => {});
  }

  if (img) {
    img.onload = ()=>{ fit(); render(true); };
    if (img.complete) { try{ fit(); render(true); }catch{} }
  }
  if (video) {
    // targetFrame must be computed inside syncVideoFrame — computing it eagerly (before
    // loadedmetadata) causes video.duration to be NaN, so getVideoClipBounds() falls back to
    // durationFrames=1 and clampVideoFrameToClip clamps every requested frame to 0.
    const getTargetFrame = () => {
      // Explicit null/undefined check before Number() — Number(null) === 0 which is
      // a valid frame index and would incorrectly short-circuit to frame 0.
      if (videoCurrentFrame != null && Number.isFinite(Number(videoCurrentFrame)))
        return clampVideoFrameToClip(Number(videoCurrentFrame));
      if (videoCurrentTime != null && Number.isFinite(Number(videoCurrentTime)))
        return clampVideoFrameToClip(mediaTimeToFrame(Number(videoCurrentTime)));
      return null;
    };
    let initialPlaybackHandled = false;
    const maybeResumeAfterSync = ()=>{
      if (initialPlaybackHandled) return;
      initialPlaybackHandled = true;
      if (videoAutoPlay) {
        enforceVideoClipBounds();
        try { video.play().catch(()=>{}); } catch {}
      }
      updateVideoTransport();
    };
    const syncVideoFrame = ()=>{
      try { video.pause(); } catch {}
      enforceVideoClipBounds();
      const targetFrame = getTargetFrame();
      if (targetFrame == null) {
        fit();
        maybeResumeAfterSync();
        return;
      }
      const currentFrame = clampVideoFrameToClip(mediaTimeToFrame(video.currentTime));
      if (video.readyState >= 2 && currentFrame === targetFrame) {
        fit();
        render(true);
        maybeResumeAfterSync();
        return;
      }
      try { setVideoFrame(targetFrame, { autoSeek: true }); } catch { fit(); maybeResumeAfterSync(); }
    };
    video.addEventListener('loadedmetadata', syncVideoFrame);
    // Blob/cached videos can fire loadedmetadata before the listener above is registered
    // (hundreds of lines of setup code run between video element creation and here).
    // If metadata is already available, call syncVideoFrame immediately.
    if (video.readyState >= 1) syncVideoFrame();
    // If the video URL is a streaming/MSE source it can't be loaded by a second element.
    // Detect failure: if duration is still 0/NaN after 2.5s, hide the video, show the
    // captured frame-lock thumbnail. If even that is missing/black, draw a placeholder.
    const _showNoVideoState = () => {
      try { video.style.setProperty('display', 'none', 'important'); } catch {}
      const tp = body.querySelector('.sm-anno-transport');
      if (tp) tp.style.setProperty('display', 'none', 'important');
      if (frameLockEl) {
        // Check if the frame-lock image loaded a non-trivial image
        const testC = document.createElement('canvas');
        testC.width = 4; testC.height = 4;
        try {
          testC.getContext('2d').drawImage(frameLockEl, 0, 0, 4, 4);
          const px = testC.getContext('2d',{willReadFrequently:true}).getImageData(0,0,4,4).data;
          let lum = 0;
          for (let i = 0; i < px.length; i += 4)
            lum += 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
          if (lum / (px.length/4) > 8) {
            // Frame-lock has a real image — show it
            frameLockEl.style.setProperty('opacity', '1', 'important');
            return;
          }
        } catch {}
      }
      // No usable frame-lock — draw a placeholder on the wrap background
      wrap?.style.setProperty('background',
        'linear-gradient(135deg,#0b0f1e 0%,#0d1428 100%)', 'important');
      const ph = document.createElement('div');
      ph.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;pointer-events:none;z-index:1;';
      ph.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(84,213,255,0.45)" stroke-width="1.2" stroke-linecap="round">
          <rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 6V4h8v2M8 18v2h8v-2"/><path d="M9 11l2 2 4-4" stroke="rgba(84,213,255,0.45)"/>
        </svg>
        <span style="font-size:11px;color:rgba(84,213,255,0.55);font-family:system-ui;text-align:center;line-height:1.4;">
          Video source unavailable<br>
          <span style="font-size:9px;opacity:0.6;">Annotations work on the captured frame</span>
        </span>`;
      wrap?.appendChild(ph);
      // Force fit so canvas is sized even without video dimensions
      const iw = logicalW || 1280, ih = logicalH || 720;
      if (!logicalW) {
        wrap?.style.setProperty('width',  Math.min(iw, (stage?.clientWidth  || iw) - 44) + 'px', 'important');
        wrap?.style.setProperty('height', Math.min(ih, (stage?.clientHeight || ih) - 170) + 'px', 'important');
        canvas.style.width  = wrap?.style.width  || '';
        canvas.style.height = wrap?.style.height || '';
        canvas.width  = Math.round((parseFloat(wrap?.style.width)  || iw) * (window.devicePixelRatio || 1));
        canvas.height = Math.round((parseFloat(wrap?.style.height) || ih) * (window.devicePixelRatio || 1));
        const ctx = ctx2d();
        if (ctx) ctx.setTransform(window.devicePixelRatio||1, 0, 0, window.devicePixelRatio||1, 0, 0);
        logicalW = parseFloat(wrap?.style.width)  || iw;
        logicalH = parseFloat(wrap?.style.height) || ih;
        render(true);
      }
    };

    const _videoFallbackTimer = setTimeout(() => {
      const dur = Number(video?.duration);
      if (!(Number.isFinite(dur) && dur > 0)) _showNoVideoState();
    }, 2500);
    video.addEventListener('loadedmetadata', () => clearTimeout(_videoFallbackTimer), { once: true });
    video.addEventListener('error', () => {
      clearTimeout(_videoFallbackTimer);
      _showNoVideoState();
    });
    // fit() on loadeddata: first time we know the intrinsic video dimensions.
    // render(true) after fit() ensures the frame-lock overlay and canvas are
    // drawn even if video.currentTime hasn't changed (no seeked event fires).
    video.addEventListener('loadeddata', () => { fit(); render(true); updateVideoTransport(); });
    // seeked: only render — no fit(). fit() is expensive (getBoundingClientRect +
    // getComputedStyle on every frame step) and the canvas size doesn't change between
    // seeks. If the stage was never sized yet, fit() will have run from loadeddata above.
    video.addEventListener('seeked', () => { render(true); maybeResumeAfterSync(); updateVideoTransport(); _on3DFrameUpdate(); });
    video.addEventListener('timeupdate', () => {
      const hitEnd = enforceVideoClipBounds({ pauseAtEnd: !video.paused });
      if (hitEnd && !video.paused) {
        if (_loopPlayback) {
          const { startFrame } = getVideoClipBounds();
          const _loopSel = objects.find(o => o.id === selectedId);
          setVideoFrame(_loopSel?.frameIn ?? startFrame);
        } else {
          try { video.pause(); } catch {}
          _cancelReverse(); _shuttleSpeed = 0;
          if (speedBadge) { speedBadge.textContent = '1×'; speedBadge.classList.remove('is-fast','is-reverse'); }
        }
      }
      // Use scheduleRender during playback — if the rAF loop is already running,
      // this is a no-op (deduplicates the timeupdate + rAF double-clear).
      if (!video.paused) scheduleRender(); else render(true);
      updateVideoTransport();
    });
    // rAF render loop: re-renders annotation canvas at ~60fps during forward playback.
    let _playRafId = null;
    const _playRafLoop = () => {
      if (!video || video.paused || video.ended) { _playRafId = null; return; }
      render(true);
      _playRafId = requestAnimationFrame(_playRafLoop);
    };
    video.addEventListener('play', () => {
      updateVideoTransport();
      if (!_playRafId && _shuttleSpeed >= 0) _playRafId = requestAnimationFrame(_playRafLoop);
    });
    video.addEventListener('pause', () => {
      if (_playRafId) { cancelAnimationFrame(_playRafId); _playRafId = null; }
      if (_shuttleSpeed > 0) {
        _shuttleSpeed = 0;
        if (speedBadge) { speedBadge.textContent = '1×'; speedBadge.classList.remove('is-fast','is-reverse'); }
      }
      updateVideoTransport();
      render(true);
    });
    video.addEventListener('ended', () => { if (_playRafId) { cancelAnimationFrame(_playRafId); _playRafId = null; } updateVideoTransport(); });
    if (video.readyState >= 1) syncVideoFrame();
    else {
      try { video.load(); } catch {}
    }
    updateVideoTransport();
  }

  return { close, commit };
}
