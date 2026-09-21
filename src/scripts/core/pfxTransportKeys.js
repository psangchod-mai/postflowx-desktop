// pfxTransportKeys.js — the single global media-transport keyboard layer.
//
// One document-level keydown/keyup dispatcher that routes to the transport of
// the *currently visible* player. Implements the JKL shuttle + Space/Home/End/
// arrows exactly as the PFXplaycontrol reference specifies. Replaces the
// scattered per-feature JKL handlers (those are guarded behind window.__PFX_TX_KEYS).
//
//   J tap            → one frame back
//   J held           → continuous reverse (release → pause)
//   K                → stop (pause in place); K+J / K+L → single-frame jog
//   L                → play forward; press again to ramp ½→1→2→4×
//   Space            → play / pause
//   Home / Fn+Left   → jump to start (blue flash)
//   End / Fn+Right   → jump to end → Out point or last frame (blue flash)
//   ← / →            → step ∓1 frame
//   Shift+← / Shift+→ → previous / next item (markers/shots/cuts/reels per tab)
'use strict';

import { getTransport, listTransports } from './pfxTransport.js';
import { isTypingTarget } from './shortcuts.js';

// Master switch — lets the old per-feature handlers fall back instantly if off.
if (typeof window !== 'undefined' && window.__PFX_TX_KEYS == null) {
  window.__PFX_TX_KEYS = true;
}

// Tab (data-main) → candidate adapter names, in priority order. The first whose
// host is actually visible wins (handles Prep/Mark's vfx/vfxws/sly sub-modes).
const TAB_ADAPTERS = {
  imf: ['imf'],
  prepmark: ['sly', 'vfxws', 'vfx', 'prepmark'],
  cutdiff2: ['cutdiff2'],
  cutdiff: ['cutdiff'],
  platelink2: ['platelink2'],
  aceslook: ['aceslook'],
  trlconf: ['trlconf'],
};

function isVisible(el) {
  try { return !!(el && el.isConnected && el.offsetParent !== null); } catch { return false; }
}

function activeController() {
  let key = null;
  try { key = document.querySelector('.tabs .tab.active')?.getAttribute('data-main'); } catch {}
  const names = TAB_ADAPTERS[key] || (key ? [key] : []);
  for (const n of names) {
    const c = getTransport(n);
    if (c && isVisible(c.el)) return c;
  }
  // Fallback: any single visible registered transport.
  let found = null;
  for (const c of listTransports()) {
    if (isVisible(c.el)) { if (found) return found; found = c; }
  }
  return found;
}

let kHeld = false;
let jReverse = false;
let jReverseCtrl = null;   // the controller that started the current hold-reverse

function done(e) { e.preventDefault(); e.stopPropagation(); }

// Reset held-key state and stop any in-progress hold-reverse on the SAME
// controller that started it. Called on keyup and on focus/visibility loss so a
// missed keyup (Cmd-Tab, window blur) can't wedge the transport in jog/reverse.
function endHoldReverse() {
  if (jReverse) { jReverse = false; const c = jReverseCtrl; jReverseCtrl = null; try { c?.reverseHoldEnd(); } catch {} }
}
function resetHeld() { kHeld = false; endHoldReverse(); }

/**
 * Pure key → transport-intent mapping. Returns { a, d? } or null. Exported for
 * unit testing — the dispatcher below adds the held-state side effects.
 *   a: prevItem|nextItem|togglePlay|jumpStart|jumpEnd|step|stop|playForward|reverseHold|noop
 */
export function resolveKey(code, { shift = false, repeat = false, kHeld = false } = {}) {
  if (shift) {
    if (code === 'ArrowLeft') return { a: 'prevItem' };
    if (code === 'ArrowRight') return { a: 'nextItem' };
    return null;
  }
  switch (code) {
    case 'Space':      return { a: 'togglePlay' };
    case 'Home':       return { a: 'jumpStart' };
    case 'End':        return { a: 'jumpEnd' };
    case 'ArrowLeft':  return { a: 'step', d: -1 };
    case 'ArrowRight': return { a: 'step', d: 1 };
    case 'KeyK':       return repeat ? { a: 'noop' } : { a: 'stop' };
    case 'KeyL':       return repeat ? { a: 'noop' } : (kHeld ? { a: 'step', d: 1 } : { a: 'playForward' });
    case 'KeyJ':
      if (kHeld) return repeat ? { a: 'noop' } : { a: 'step', d: -1 };
      return repeat ? { a: 'reverseHold' } : { a: 'step', d: -1 };
    default:           return null;
  }
}

function onKeyDown(e) {
  if (!window.__PFX_TX_KEYS) return;
  if (isTypingTarget(e.target)) return;
  // Leave Cmd/Ctrl/Alt combos to the app's own shortcuts.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.code === 'KeyK') kHeld = true;          // track held state for K+J / K+L jog

  const intent = resolveKey(e.code, { shift: e.shiftKey, repeat: e.repeat, kHeld });
  if (!intent) return;

  const c = activeController(); if (!c) return;

  switch (intent.a) {
    case 'prevItem':    c.cmd.prevItem(); break;
    case 'nextItem':    c.cmd.nextItem(); break;
    case 'togglePlay':  c.cmd.togglePlayPause(); break;
    case 'jumpStart':   c.cmd.jumpStart(); break;
    case 'jumpEnd':     c.cmd.jumpEnd(); break;
    case 'step':        c.cmd.stepFrame(intent.d); break;
    case 'stop':        c.cmd.stop(); break;
    case 'playForward': c.cmd.playForward(); break;
    case 'reverseHold': if (!jReverse) { jReverse = true; jReverseCtrl = c; c.reverseHoldStart(); } break;
    case 'noop':        break;
  }
  done(e);
}

function onKeyUp(e) {
  if (!window.__PFX_TX_KEYS) return;
  if (e.code === 'KeyK') kHeld = false;
  if (e.code === 'KeyJ') endHoldReverse();   // stop reverse on the controller that started it
}

function init() {
  try {
    document.addEventListener('keydown', onKeyDown, true);   // capture: pre-empt feature handlers
    document.addEventListener('keyup', onKeyUp, true);
    // A missed keyup (window blur, Cmd-Tab, tab hidden) must not wedge held state.
    window.addEventListener('blur', resetHeld);
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetHeld(); });
  } catch {}
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

export { activeController };
