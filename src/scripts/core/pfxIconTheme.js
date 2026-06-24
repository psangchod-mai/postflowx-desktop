import { iconSvg, setIconButton, setLabeledIcon, setPlayPauseIconButton } from './iconButtons.js';

function $(selector, root = document){
  try{ return root.querySelector(selector); }catch(_){ return null; }
}

const escHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

function applyMap(entries = []){
  entries.forEach((entry) => {
    const el = typeof entry.selector === 'string' ? $(entry.selector) : entry.selector;
    if (!el) return;
    setLabeledIcon(el, entry.icon, entry.label, {
      visibleLabel: entry.visibleLabel !== false,
      variant: entry.variant,
      size: entry.size,
      extraClass: entry.extraClass,
      trailingHtml: entry.trailingHtml,
      keepBar: entry.keepBar,
      keepTitle: entry.keepTitle,
      iconOnly: entry.iconOnly,
    });
  });
}

function setKpiLabel(node, icon, text){
  if (!node) return;
  node.classList.add('pfx-kpi-label');
  node.innerHTML = `<span class="pfx-kpi-ico" aria-hidden="true">${iconSvg(icon)}</span><span class="pfx-kpi-txt">${text}</span>`;
}

function setCardTitle(node, icon, text){
  if (!node) return;
  const label = text || node.textContent || '';
  node.classList.add('pfx-card-title--iconized');
  node.innerHTML = `<span class="pfx-card-title-ico" aria-hidden="true">${iconSvg(icon)}</span><span class="pfx-card-title-txt">${label}</span>`;
}

function setAssetButtonIcon(node, src, label, opts = {}){
  if (!node) return;
  const visibleLabel = opts.visibleLabel !== false;
  const hasBar = opts.keepBar === true || (opts.keepBar !== false && !!node.querySelector?.('.bar'));
  const trailingHtml = opts.trailingHtml || '';
  const iconOnly = opts.iconOnly || !visibleLabel;
  node.classList.remove('pfx-iconbtn');
  node.classList.add('pfx-lblbtn', 'pfx-lblbtn--asset');
  if (opts.variant) node.dataset.pfxVariant = opts.variant;
  if (opts.size) node.dataset.pfxSize = opts.size;
  if (opts.extraClass) node.classList.add(opts.extraClass);
  if (label){
    node.setAttribute('aria-label', label);
    if (!opts.keepTitle) node.title = label;
  }
  node.innerHTML = `${hasBar ? '<span class=\"bar\"></span>' : ''}`
    + `<span class=\"pfx-lbl-ico pfx-lbl-ico--asset\" aria-hidden=\"true\"><img src=\"${escHtml(src)}\" alt=\"\"></span>`
    + (visibleLabel
      ? `<span class=\"pfx-lbl-txt\">${escHtml(label || '')}</span>`
      : `<span class=\"pfx-sr\">${escHtml(label || '')}</span>`)
    + trailingHtml;
  if (iconOnly) node.classList.add('pfx-lblbtn--icononly');
  else node.classList.remove('pfx-lblbtn--icononly');
}

export function applyPfxIconTheme(){
  // Main tabs
  applyMap([
    { selector: '.tabs > .tab[data-main="edl"]',        icon: 'pullprep', label: 'PULL PREP', variant: 'tab', size: 'lg' },
    { selector: '.tabs > .tab[data-main="cutdiff"]',    icon: 'cutdiff',  label: 'CUT DIFF', variant: 'tab', size: 'lg' },
    { selector: '.tabs > .tab[data-main="shotmarker"]', icon: 'marker',   label: 'MARKERS', variant: 'tab', size: 'lg' },
    { selector: '.tabs > .tab[data-main="amf"]',        icon: 'link',     label: 'PLATE LINK', variant: 'tab', size: 'lg' },
    { selector: '.tabs > .tab[data-main="reviews"]',    icon: 'qc',       label: 'VISUAL QC', variant: 'tab', size: 'lg' },
    { selector: '.tabs > .tab[data-main="about"]',      icon: 'settings', label: 'SETTINGS & FEEDBACK', variant: 'tab', size: 'lg' },
  ]);

  // Project bar / global actions
  try{ setIconButton($('#projPickDir'), 'folder', 'Set Project Save Folder'); }catch(_){ }
  applyMap([
    { selector: '#projBurnin', icon: 'burnin', label: 'OCR', variant: 'button', keepTitle: true },
    { selector: '#projNew',    icon: 'newFile', label: 'New', variant: 'button' },
    { selector: '#projSave',   icon: 'save', label: 'Save', variant: 'button' },
    { selector: '#projSaveAs', icon: 'saveAs', label: 'Save As', variant: 'button' },
    { selector: '#projLoad',   icon: 'load', label: 'Load', variant: 'button' },
    { selector: '#projDelete', icon: 'trash', label: 'Delete', variant: 'button' },
  ]);

  // Settings / About / Feedback
  setCardTitle($('#ntCard .card-title'), 'note', 'Scope of Work / Note Types');
  setCardTitle($('#scCard .card-title'), 'keyboard', 'Keyboard Shortcuts');
  setCardTitle($('#camTplCard .card-title'), 'camera', 'Camera Format Profiles');
  setCardTitle($('#main-about .about-retro .card-title'), 'info', 'ABOUT');
  setCardTitle($('#fbCard .card-title'), 'feedback', 'User Feedback');

  applyMap([
    { selector: '#versionBtn',       icon: 'info',     label: ($('#versionBtn')?.textContent || 'Current Version').trim(), variant: 'button' },
    { selector: '#updateBtn',        icon: 'refresh',  label: ($('#updateBtn')?.textContent || 'Update Version').trim(), variant: 'button' },
    { selector: '#mmPickProjectDir', icon: 'folder',   label: 'Set Project Folder', variant: 'button' },
    { selector: '#mmPickMediaRoot',  icon: 'bin',      label: 'Set Media Root', variant: 'button' },
    { selector: '#mmRescan',         icon: 'refresh',  label: 'Rescan', variant: 'button' },
    { selector: '#mmClearMediaRoot', icon: 'clear',    label: 'Clear', variant: 'button' },
    { selector: '#ntOpen',           icon: 'note',     label: 'Edit Note Types', variant: 'button' },
    { selector: '#ntReset',          icon: 'refresh',  label: 'Reset', variant: 'button' },
    { selector: '#scOpen',           icon: 'keyboard', label: 'Edit Shortcuts', variant: 'button' },
    { selector: '#scReset',          icon: 'refresh',  label: 'Reset', variant: 'button' },
    { selector: '#camTplOpen',       icon: 'camera',   label: 'Edit Camera Profiles', variant: 'button' },
    { selector: '#camTplReset',      icon: 'refresh',  label: 'Reset', variant: 'button' },
    { selector: '#fbToggleCfg',      icon: 'settings', label: 'Config', variant: 'button' },
    { selector: '#fbSaveCfg',        icon: 'save',     label: 'Save', variant: 'button' },
    { selector: '#fbCopyScript',     icon: 'copy',     label: 'Copy Apps Script', variant: 'button' },
    { selector: '#fbSubmit',         icon: 'feedback', label: 'Submit', variant: 'button' },
    { selector: '#fbClear',          icon: 'clear',    label: 'Clear', variant: 'button' },
  ]);

  // About page accordions
  setCardTitle($('#main-about details.about-section:nth-of-type(1) > summary'), 'pullprep', 'Pull Prep');
  setCardTitle($('#main-about details.about-section:nth-of-type(2) > summary'), 'cutdiff', 'Cut Diff');
  setCardTitle($('#main-about details.about-section:nth-of-type(3) > summary'), 'link', 'Plate Link');
  setCardTitle($('#main-about details.about-section:nth-of-type(4) > summary'), 'marker', 'Markers');
  setCardTitle($('#main-about details.about-section:nth-of-type(5) > summary'), 'qc', 'Review');

  // Pull Prep — Input / Inspector / export
  applyMap([
    { selector: '#inputCard .inner-tab[data-itab="input"]',     icon: 'input',     label: 'Input', variant: 'tab' },
    { selector: '#inputCard .inner-tab[data-itab="inspector"]', icon: 'inspector', label: 'Inspector', variant: 'tab' },
    { selector: '#btnExportOTIO', icon: 'exportOtio', label: 'Export OTIO', variant: 'button', trailingHtml: ' <span class="otio-caret" aria-hidden="true"></span>' },
    { selector: '#btnExportEDL',  icon: 'exportEdl',  label: 'Export EDL', variant: 'button' },
  ]);

  setKpiLabel($('#kEvents')?.closest('.k')?.querySelector('.muted'), 'events', 'Events');
  setKpiLabel($('#kReels')?.closest('.k')?.querySelector('.muted'), 'reels', 'Unique Reels');
  setKpiLabel($('#kFps')?.closest('.k')?.querySelector('.muted'), 'fps', 'FPS');
  setKpiLabel($('#kStorageWrap .kpi-title'), 'storage', 'Storage (Est.) Pull as');

  // Pull Prep — quick settings
  applyMap([
    { selector: '#qsAllOff',                                   icon: 'power',     label: 'All OFF', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="conform"]',        icon: 'conform',   label: 'Conform', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="vfxrename"]',      icon: 'rename',    label: 'VFX Rename', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="vfxmarker"]',      icon: 'marker',    label: 'VFX Marker', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="merge"]',          icon: 'merge',     label: 'Merge', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="flatten"]',        icon: 'flatten',   label: 'Flatten', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="decompose"]',      icon: 'decompose', label: 'Decompose', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="metadata"]',       icon: 'metadata',  label: 'Metadata', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="autosplit"]',      icon: 'autosplit', label: 'Auto Split', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="df"]',             icon: 'dfNdf',     label: 'DF → NDF', variant: 'button' },
    { selector: '#qsRow .qs-btn[data-key="extra"]',          icon: 'retime',    label: 'Retime Handles+', variant: 'button' },
  ]);

  // Plate Link — card title / summary / actions
  setCardTitle($('#amfCard .card-title'), 'link', 'Plate Link');
  setKpiLabel($('#amfSummary .k-shots .amf-kpi-label'), 'shotsList', 'Shots');
  setKpiLabel($('#amfSummary .k-ready .amf-kpi-label'), 'ready', 'Ready');
  setKpiLabel($('#amfSummary .k-missing .amf-kpi-label'), 'missing', 'Missing');

  applyMap([
    { selector: '#amfChooseFolder',   icon: 'folder',    label: 'Choose VFX Folder', variant: 'button' },
    { selector: '#amfRescan',         icon: 'refresh',   label: 'Rescan', variant: 'button' },
    { selector: '#amfClear',          icon: 'clear',     label: 'Clear', variant: 'button' },
    { selector: '#amfExportJson',     icon: 'json',      label: 'Mapping (.json)', variant: 'button' },
    { selector: '#amfFlowConnect',    icon: 'link',      label: 'Connect', variant: 'button' },
    { selector: '#amfExportShotsCsv', icon: 'shotsList', label: 'VFX Shots List', variant: 'button', trailingHtml: ' <span class="amf-caret" aria-hidden="true">▾</span>' },
  ]);
  setAssetButtonIcon($('#amfGenerateAEP'),  'assets/icons/icon_ae.png',   'AE XML (.aepx)', { variant: 'button' });
  setAssetButtonIcon($('#amfExportAE'),     'assets/icons/icon_ae.png',   'AE Script (.jsx)',  { variant: 'button' });
  setAssetButtonIcon($('#amfExportNukeNK'), 'assets/icons/icon_nuke.png', 'Nuke Project (.nk)', { variant: 'button' });

  const amfStatusMain = $('#amfExportStatusMain');
  if (amfStatusMain && !amfStatusMain.querySelector('.pfx-card-title-ico')) {
    amfStatusMain.innerHTML = `<span class="pfx-card-title-ico" aria-hidden="true">${iconSvg('status')}</span><span class="pfx-card-title-txt">${amfStatusMain.textContent || 'Status: Ready'}</span>`;
    amfStatusMain.classList.add('pfx-card-title--iconized', 'pfx-plate-status-main');
  }

  // Cut Diff — actions + exports
  applyMap([
    { selector: '#cutdiffClearBtn',     icon: 'clear',     label: 'Clear', variant: 'button', visibleLabel: true },
    { selector: '#cutdiffAnalyzeBtn',   icon: 'analyze',   label: 'Analyze', variant: 'button', visibleLabel: true },
    { selector: '#cutdiffExportBtn',    icon: 'exportEdl', label: 'Export', variant: 'button', visibleLabel: true, trailingHtml: ' <span class="cd-export-caret" aria-hidden="true">▾</span>' },
    { selector: '#cutdiffExportPdfBtn', icon: 'pdf',       label: 'PDF', variant: 'button', visibleLabel: true },
  ]);

  // Cut Diff — compare modes
  applyMap([
    { selector: '.cd-vcmp-mode[data-mode="wipe"]',  icon: 'wipe',       label: 'Wipe', variant: 'chip', size: 'sm', visibleLabel: true },
    { selector: '.cd-vcmp-mode[data-mode="sbs"]',   icon: 'sideBySide', label: 'Side by side', variant: 'chip', size: 'sm', visibleLabel: true },
    { selector: '.cd-vcmp-mode[data-mode="split"]', icon: 'split',      label: 'Split', variant: 'chip', size: 'sm', visibleLabel: true },
    { selector: '.cd-vcmp-mode[data-mode="ab"]',    icon: 'ab',         label: 'A/B', variant: 'chip', size: 'sm', visibleLabel: true },
    { selector: '.cd-vcmp-mode[data-mode="diff"]',  icon: 'diff',       label: 'Diff', variant: 'chip', size: 'sm', visibleLabel: true },
    { selector: '.cd-vcmp-mode[data-mode="heat"]',  icon: 'heat',       label: 'Heat', variant: 'chip', size: 'sm', visibleLabel: true },
  ]);

  // Cut Diff — transport controls
  try{ setIconButton($('#cutdiffVcmpHome'),  'home',      'To selection start'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpPrevF'), 'prevFrame', 'Previous frame'); }catch(_){ }
  try{ setPlayPauseIconButton($('#cutdiffVcmpPlay'), 'Play / Pause'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpNextF'), 'nextFrame', 'Next frame'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpEnd'),   'end',       'To selection end'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpCleanFeed'), 'monitor',    'Clean Feed'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpChain'),     'chain',      'Frames chained'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpLoop'),      'loop',       'Loop selected change'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpAudio'),     'audio',      'Audio'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpFit'),       'fit',        'Fit / Fill'); }catch(_){ }
  try{ setIconButton($('#cutdiffVcmpFull'),      'fullscreen', 'Fullscreen'); }catch(_){ }

  // Cut Diff — timeline mode buttons
  applyMap([
    { selector: '#cutdiffTlModeCompare', icon: 'compare',   label: 'Compare', variant: 'chip', size: 'sm' },
    { selector: '#cutdiffTlModeNew',     icon: 'newStatus', label: 'NEW',     variant: 'chip', size: 'sm' },
    { selector: '#cutdiffTlModeOld',     icon: 'oldStatus', label: 'OLD',     variant: 'chip', size: 'sm' },
  ]);
}
