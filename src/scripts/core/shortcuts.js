// scripts/app/core/shortcuts.js
// PostFlowX – User-configurable keyboard shortcuts
// - Stored in localStorage under pfx.* so Project Storage v4 includes it in settings.json
// - Supports multiple bindings per action (chips, like Note Types)

export const PFX_SHORTCUTS_KEY = 'pfx.shortcuts.v1';

// Actions registry (shown in Settings > Keyboard Shortcuts)
// `contexts` is advisory for features to decide when to resolve shortcuts.
export const PFX_SHORTCUT_ACTIONS = [
  // Playback / viewer
  { id: 'play_toggle',       name: 'Play / Pause',        group: 'Playback', contexts: ['viewer','timeline'], defaults: ['Space'] },
  { id: 'viewer_fullscreen', name: 'Toggle Fullscreen',   group: 'Playback', contexts: ['viewer','timeline'], defaults: ['KeyP','KeyF'] },

  // Timeline navigation (generic across tabs)
  { id: 'step_back',         name: 'Step / Nudge Back',    group: 'Timeline', contexts: ['viewer','timeline'], defaults: ['ArrowLeft','SHIFT+ArrowLeft'] },
  { id: 'step_forward',      name: 'Step / Nudge Forward', group: 'Timeline', contexts: ['viewer','timeline'], defaults: ['ArrowRight','SHIFT+ArrowRight'] },
  { id: 'step_back_fine',    name: 'Fine Step Back',       group: 'Timeline', contexts: ['viewer','timeline'], defaults: ['Comma'] },
  { id: 'step_forward_fine', name: 'Fine Step Forward',    group: 'Timeline', contexts: ['viewer','timeline'], defaults: ['Period'] },
  { id: 'nav_prev',          name: 'Previous Item',        group: 'Timeline', contexts: ['timeline'],          defaults: ['ArrowUp'] },
  { id: 'nav_next',          name: 'Next Item',            group: 'Timeline', contexts: ['timeline'],          defaults: ['ArrowDown'] },
  // J/K are reserved for the global JKL transport shuttle (pfxTransportKeys.js);
  // marker nav uses Shift+Arrows so the two don't collide.
  { id: 'nav_prev_marker',   name: 'Previous Marker',      group: 'Markers',  contexts: ['markers','timeline'],defaults: ['SHIFT+ArrowUp'] },
  { id: 'nav_next_marker',   name: 'Next Marker',          group: 'Markers',  contexts: ['markers','timeline'],defaults: ['SHIFT+ArrowDown'] },
  { id: 'home',              name: 'Go to Start',          group: 'Timeline', contexts: ['timeline'],          defaults: ['Home'] },
  { id: 'end',               name: 'Go to End',            group: 'Timeline', contexts: ['timeline'],          defaults: ['End'] },

  // Zoom
  { id: 'zoom_fit',          name: 'Fit Timeline',         group: 'Timeline', contexts: ['timeline'],          defaults: ['KeyZ','MOD+Digit0'] },
  { id: 'zoom_in',           name: 'Zoom In',              group: 'Timeline', contexts: ['timeline'],          defaults: ['MOD+Equal','MOD+SHIFT+Equal'] },
  { id: 'zoom_out',          name: 'Zoom Out',             group: 'Timeline', contexts: ['timeline'],          defaults: ['MOD+Minus'] },

  // Marker / edit actions
  { id: 'marker_add',        name: 'Add Marker',           group: 'Markers',  contexts: ['markers','viewer','timeline'], defaults: ['KeyM'] },
  { id: 'cut_add',           name: 'Add Cut',              group: 'Timeline', contexts: ['timeline'],          defaults: ['KeyC'] },

  // Undo / redo (per-feature decides what to undo)
  { id: 'undo',              name: 'Undo',                 group: 'Global',   contexts: ['global','timeline','viewer','markers'], defaults: ['MOD+KeyZ'] },
  { id: 'redo',              name: 'Redo',                 group: 'Global',   contexts: ['global','timeline','viewer','markers'], defaults: ['MOD+SHIFT+KeyZ','MOD+KeyY'] },

  // Delete (optional)
  { id: 'delete',            name: 'Delete',               group: 'Global',   contexts: ['global','timeline','markers'], defaults: ['Delete','Backspace'] },
];

// Shortcuts that mutate data — blocked in read-only mode.
// Used by keydown handlers: check `PFX_SHORTCUT_MUTATING.has(actionId)` before running.
export const PFX_SHORTCUT_MUTATING = new Set([
  'marker_add', 'cut_add', 'delete', 'undo', 'redo',
]);

/**
 * Returns false if the action is mutating and read-only mode is active.
 * @param {string} actionId
 */
export function isShortcutAllowed(actionId) {
  if (!PFX_SHORTCUT_MUTATING.has(actionId)) return true;
  if (window.PFX_READONLY?.isActive?.()) {
    window.PFX_GUARD?.toast?.(`Read-only — "${actionId}" shortcut blocked`, 'deny');
    return false;
  }
  if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('edit_cut')) {
    window.PFX_GUARD?.toast?.(`Permission denied — "${actionId}" shortcut`, 'deny');
    return false;
  }
  return true;
}

function safeParseJSON(s){
  try{ return JSON.parse(String(s||'')); }catch{ return null; }
}

function deepCopy(v){
  try{ return structuredClone(v); }catch{}
  try{ return JSON.parse(JSON.stringify(v)); }catch{}
  return v;
}

export function isTypingTarget(el){
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

const MODIFIER_CODES = new Set([
  'ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','Shift','Control','Alt','Meta'
]);

function isMac(){
  try{ return String(navigator.platform || '').toUpperCase().includes('MAC'); }catch{ return false; }
}

function normalizeCodeFromEvent(e){
  const code = String(e?.code || '');
  if (code) return code;
  // fallback for odd cases
  const k = String(e?.key || '');
  if (k === ' ') return 'Space';
  if (k === ',') return 'Comma';
  if (k === '.') return 'Period';
  return k;
}

function buildComboTokens({ useModAlias, ctrl, meta, alt, shift, code }){
  const tokens = [];

  // MOD alias (Cmd on Mac, Ctrl on Win)
  if (useModAlias){
    const mac = isMac();
    const modDown = mac ? meta : ctrl;
    if (modDown) tokens.push('MOD');
    // If user holds the *other* modifier too, keep it explicit.
    if (mac && ctrl) tokens.push('CTRL');
    if (!mac && meta) tokens.push('META');
  }else{
    if (ctrl) tokens.push('CTRL');
    if (meta) tokens.push('META');
  }

  if (alt) tokens.push('ALT');
  if (shift) tokens.push('SHIFT');
  tokens.push(code);
  return tokens.join('+');
}

// Returns a canonical combo string for capturing & storage.
// Prefer MOD alias for primary modifier to be portable across Win/Mac.
export function captureComboFromEvent(e){
  if (!e) return '';
  const code = normalizeCodeFromEvent(e);
  if (!code || MODIFIER_CODES.has(code)) return '';

  const ctrl = !!e.ctrlKey;
  const meta = !!e.metaKey;
  const alt = !!e.altKey;
  const shift = !!e.shiftKey;

  return buildComboTokens({ useModAlias: true, ctrl, meta, alt, shift, code });
}

// Returns both explicit and MOD-aliased variants, for matching.
export function eventComboVariants(e){
  if (!e) return [];
  const code = normalizeCodeFromEvent(e);
  if (!code || MODIFIER_CODES.has(code)) return [];
  const ctrl = !!e.ctrlKey;
  const meta = !!e.metaKey;
  const alt = !!e.altKey;
  const shift = !!e.shiftKey;
  const a = buildComboTokens({ useModAlias: false, ctrl, meta, alt, shift, code });
  const b = buildComboTokens({ useModAlias: true,  ctrl, meta, alt, shift, code });
  return a === b ? [a] : [a, b];
}

export function comboToDisplay(combo){
  const raw = String(combo || '').trim();
  if (!raw) return '-';

  const mac = isMac();
  const parts = raw.split('+').filter(Boolean);
  const out = [];
  for (const p0 of parts){
    const p = String(p0);
    if (p === 'MOD') out.push(mac ? 'Cmd' : 'Ctrl');
    else if (p === 'CTRL') out.push('Ctrl');
    else if (p === 'META') out.push('Cmd');
    else if (p === 'ALT') out.push(mac ? 'Opt' : 'Alt');
    else if (p === 'SHIFT') out.push('Shift');
    else {
      // code pretty print
      let s = p;
      if (s === 'Space') s = 'Space';
      else if (s === 'Comma') s = ',';
      else if (s === 'Period') s = '.';
      else if (s === 'Equal') s = '=';
      else if (s === 'Minus') s = '-';
      else if (s.startsWith('Key') && s.length === 4) s = s.slice(3);
      else if (s.startsWith('Digit') && s.length === 6) s = s.slice(5);
      else if (s.startsWith('Numpad')) s = s.replace('Numpad','Num ');
      out.push(s);
    }
  }
  return out.join('+');
}

function defaultConfig(){
  const out = {};
  for (const a of PFX_SHORTCUT_ACTIONS){
    out[a.id] = { enabled: true, combos: Array.isArray(a.defaults) ? a.defaults.slice() : [] };
  }
  return out;
}

// Merge stored config with defaults, ensure shape.
function mergeConfig(stored){
  const def = defaultConfig();
  const s = (stored && typeof stored === 'object') ? stored : {};
  const out = deepCopy(def);
  for (const id of Object.keys(def)){
    const v = s[id];
    if (!v) continue;

    // Back-compat: allow string as single combo
    if (typeof v === 'string'){
      out[id].combos = v ? [String(v)] : [];
      continue;
    }

    if (typeof v.enabled === 'boolean') out[id].enabled = v.enabled;
    if (Array.isArray(v.combos)) out[id].combos = v.combos.filter(Boolean).map(x=>String(x));
  }
  return out;
}

let _cache = null;
let _cacheRaw = null;

export function getShortcutsConfig(){
  try{
    const raw = localStorage.getItem(PFX_SHORTCUTS_KEY);
    if (raw && raw === _cacheRaw && _cache) return _cache;
    const parsed = safeParseJSON(raw);
    _cache = mergeConfig(parsed);
    _cacheRaw = raw;
    return _cache;
  }catch{
    _cache = defaultConfig();
    _cacheRaw = null;
    return _cache;
  }
}

export function setShortcutsConfig(cfg){
  try{
    const safe = {};
    const def = defaultConfig();
    for (const id of Object.keys(def)){
      const v = cfg?.[id];
      safe[id] = {
        enabled: v?.enabled !== false,
        combos: Array.isArray(v?.combos) ? v.combos.filter(Boolean).map(x=>String(x)) : []
      };
    }
    const json = JSON.stringify(safe);
    localStorage.setItem(PFX_SHORTCUTS_KEY, json);
    _cache = mergeConfig(safe);
    _cacheRaw = json;
    try{ window.dispatchEvent(new CustomEvent('pfx:shortcuts-changed', { detail: _cache })); }catch{}
  }catch{}
}

export function resetShortcutsToDefaults(){
  setShortcutsConfig(defaultConfig());
}

export function actionMeta(actionId){
  return PFX_SHORTCUT_ACTIONS.find(a => a.id === actionId) || null;
}

export function actionDefaultCombos(actionId){
  const a = actionMeta(actionId);
  return Array.isArray(a?.defaults) ? a.defaults.slice() : [];
}

export function listShortcutActions(){
  return PFX_SHORTCUT_ACTIONS.slice();
}

export function resolveShortcutAction(e, actionIds, opts={}){
  const cfg = opts.cfg || getShortcutsConfig();
  const variants = eventComboVariants(e);
  if (!variants.length) return null;
  const allowDisabled = !!opts.allowDisabled;

  const ids = Array.isArray(actionIds) && actionIds.length
    ? actionIds
    : Object.keys(cfg || {});

  for (const id of ids){
    const a = cfg?.[id];
    if (!a) continue;
    if (!allowDisabled && a.enabled === false) continue;
    const combos = Array.isArray(a.combos) ? a.combos : [];
    if (!combos.length) continue;
    for (const v of variants){
      if (combos.includes(v)) return id;
    }
  }
  return null;
}

export function computeCustomCount(cfg){
  const cur = cfg || getShortcutsConfig();
  const def = defaultConfig();
  let custom = 0;
  let total = 0;
  for (const id of Object.keys(def)){
    total++;
    const a = cur[id] || {};
    const d = def[id] || {};
    const curCombos = (a.combos || []).slice().sort().join('|');
    const defCombos = (d.combos || []).slice().sort().join('|');
    if ((a.enabled !== false) !== (d.enabled !== false) || curCombos !== defCombos) custom++;
  }
  return { total, custom };
}
