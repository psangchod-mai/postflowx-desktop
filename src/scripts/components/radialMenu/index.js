// PostFlowX Radial Menu (shared module)
// - Used by Markers / Reviews / Plate Link
// - Right-click => opens; Shift+Right-click => native context menu (handled by caller)

export const RadialIcons = {
  // Marker/Review tools
  note: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l5-5V5a2 2 0 0 0-2-2z"/><polyline points="14 3 14 8 19 8"/><line x1="7" y1="13" x2="13" y2="13"/><line x1="7" y1="17" x2="11" y2="17"/></svg>`,
  pen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7 21H3v-4L17 3z"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  circle: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>`,
  rect: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  text: `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 4 20 4"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon class="pfx-rt-ico-fill" points="9 6 20 12 9 18 9 6"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="pfx-rt-ico-fill" x="6" y="5" width="4" height="14" rx="1"/><rect class="pfx-rt-ico-fill" x="14" y="5" width="4" height="14" rx="1"/></svg>`,
  fit: `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  full: `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  // QC (match the visual weight + centering of other radial icons)
  qc: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="8.2 12.4 11.0 15.2 16.0 9.4"/></svg>`,

  // Plate Link (AMF) tools
  folder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/><path d="M4 10h16v10H4z" opacity="0.25"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>`,
  clear: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  export: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10"/><polyline points="8 9 12 13 16 9"/><path d="M4 14v5h16v-5"/></svg>`,
  info: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="10" x2="12" y2="16"/><circle cx="12" cy="7" r="1" class="pfx-rt-ico-fill"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>`,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Create a shared radial menu.
 *
 * actions: Array of
 *   {
 *     id: string,
 *     title: string,
 *     icon: string | (()=>string),
 *     onSelect: (id)=>void|Promise<void>,
 *     isEnabled?: ()=>boolean
 *   }
 */
export function createRadialMenu({
  ariaLabel = 'Quick tools',
  actions = [],
  // Base radius; actual layout may expand slightly based on number of items
  // to ensure comfortable spacing between buttons.
  radius = 74,
  // Keep the menu center away from window edges.
  // (Menu is ~260px square; 140px pad keeps it fully visible.)
  pad = 140,
  getHost = () => (document.fullscreenElement || document.webkitFullscreenElement || document.body),
  closeOnTabChange = true,
} = {}) {
  const menu = document.createElement('div');
  menu.className = 'pfx-rtmenu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', ariaLabel);

  const ring = document.createElement('div');
  ring.className = 'pfx-rtmenu-ring';

  const center = document.createElement('div');
  center.className = 'pfx-rtmenu-center';
  center.textContent = '×';
  center.title = 'Close';

  menu.appendChild(ring);
  menu.appendChild(center);

  const btnById = new Map();
  const btns = [];

  const build = () => {
    ring.textContent = '';
    btnById.clear();
    btns.length = 0;
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pfx-rtmenu-btn';
      b.dataset.act = String(a.id || '');
      b.title = String(a.title || '');
      b.innerHTML = (typeof a.icon === 'function') ? (a.icon() || '') : (a.icon || '');
      ring.appendChild(b);
      btnById.set(b.dataset.act, b);
      btns.push(b);
    }
  };

  const layout = () => {
    const n = Math.max(1, btns.length);

    // --- Spacing: avoid a cramped ring ---
    // Button is ~44px, so keep ~12px air between buttons along the arc.
    // Required radius ~= (arcPerItem * n) / (2π)
    const BTN = 44;
    const GAP = 12;
    const arcPerItem = BTN + GAP;
    const needed = (arcPerItem * n) / (2 * Math.PI);
    const r = clamp(Math.max(radius, needed), 62, 118);
    for (let i = 0; i < btns.length; i++) {
      const ang = (-90 + (360 * i / n)) * Math.PI / 180;
      const dx = Math.round(Math.cos(ang) * r);
      const dy = Math.round(Math.sin(ang) * r);
      btns[i].style.setProperty('--dx', `${dx}px`);
      btns[i].style.setProperty('--dy', `${dy}px`);
    }
  };

  let open = false;
  const close = () => {
    if (!open) return;
    open = false;
    try { menu.classList.remove('is-open'); } catch {}
  };

  const refreshDynamic = () => {
    for (const a of actions) {
      const id = String(a.id || '');
      const b = btnById.get(id);
      if (!b) continue;
      try {
        if (typeof a.icon === 'function') b.innerHTML = a.icon() || '';
      } catch {}
      let en = true;
      try { if (typeof a.isEnabled === 'function') en = !!a.isEnabled(); } catch {}
      b.classList.toggle('is-disabled', !en);
      b.disabled = !en;
    }
  };

  const openAt = (x, y) => {
    build();
    layout();
    refreshDynamic();

    const host = (() => { try { return getHost() || document.body; } catch { return document.body; } })();
    const hostW = (host === document.body || host === document.documentElement) ? (window.innerWidth || 0) : (host.clientWidth || window.innerWidth || 0);
    const hostH = (host === document.body || host === document.documentElement) ? (window.innerHeight || 0) : (host.clientHeight || window.innerHeight || 0);
    const cx = clamp(Number(x) || 0, pad, hostW - pad);
    const cy = clamp(Number(y) || 0, pad, hostH - pad);

    menu.style.left = `${cx}px`;
    menu.style.top = `${cy}px`;

    try {
      if (menu.parentElement !== host) host.appendChild(menu);
    } catch {
      try { document.body.appendChild(menu); } catch {}
    }

    open = true;
    try { menu.classList.add('is-open'); } catch {}
  };

  const onRingClick = async (e) => {
    const b = e.target?.closest?.('.pfx-rtmenu-btn');
    if (!b) return;
    const act = String(b.dataset.act || '');
    if (b.disabled || b.classList.contains('is-disabled')) return;
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    close();
    const a = actions.find(x => String(x.id) === act);
    if (!a || typeof a.onSelect !== 'function') return;
    try { await a.onSelect(act); } catch {}
  };

  ring.addEventListener('click', onRingClick);
  center.addEventListener('click', (e) => { try { e.preventDefault(); } catch {}; close(); });

  const onDocDown = (e) => {
    if (!open) return;
    try { if (menu.contains(e.target)) return; } catch {}
    close();
  };

  const onKey = (e) => {
    if (!open) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'escape') { try { e.preventDefault(); } catch {}; close(); }
  };

  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('keydown', onKey, true);
  if (closeOnTabChange) document.addEventListener('mps:mainTabChanged', close);

  const destroy = () => {
    try { close(); } catch {}
    try { ring.removeEventListener('click', onRingClick); } catch {}
    try { document.removeEventListener('pointerdown', onDocDown, true); } catch {}
    try { window.removeEventListener('keydown', onKey, true); } catch {}
    if (closeOnTabChange) {
      try { document.removeEventListener('mps:mainTabChanged', close); } catch {}
    }
    try { menu.remove(); } catch {}
  };

  return { openAt, close, destroy, el: menu };
}
