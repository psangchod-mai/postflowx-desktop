// scripts/app/core/zoomModeMenu.js
// Shared compact Zoom Mode dropdown used by Markers / Visual QC / Pull Prep timelines.

export const ZOOM_MODE = Object.freeze({
  FULL: 'full',
  DETAIL: 'detail',
  CUSTOM: 'custom',
});

const SVG = {
  chevron: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>`,
  button: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="10" height="4" rx="1.2"></rect>
      <path d="M3 12.5h10"></path>
      <path d="M5 9.4v3.1"></path>
      <path d="M8 9.4v3.1"></path>
      <path d="M11 9.4v3.1"></path>
      <circle cx="15.7" cy="14.1" r="4.1"></circle>
      <path d="M18.75 17.15 21 19.4"></path>
    </svg>`,
  full: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="10" height="4" rx="1.2"></rect>
      <path d="M3 12.4h10"></path>
      <path d="M4.8 9.2v3"></path>
      <path d="M7.3 9.2v3"></path>
      <path d="M9.8 9.2v3"></path>
      <path d="M12.3 9.2v3"></path>
      <circle cx="16.2" cy="13.9" r="3.9"></circle>
      <path d="M19.1 16.8 21 18.7"></path>
    </svg>`,
  detail: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="5" width="8.5" height="4" rx="1.2"></rect>
      <path d="M4 12.4h8.5"></path>
      <path d="M5.8 9.2v3"></path>
      <path d="M8.2 9.2v3"></path>
      <path d="M10.6 9.2v3"></path>
      <circle cx="16.4" cy="13.9" r="4.2"></circle>
      <path d="M19.5 16.9 21.2 18.6"></path>
    </svg>`,
  custom: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5" width="6.5" height="4" rx="1.2"></rect>
      <path d="M5.5 12.4H12"></path>
      <path d="M7.2 9.2v3"></path>
      <path d="M9.3 9.2v3"></path>
      <circle cx="16.6" cy="13.9" r="4.2"></circle>
      <path d="M19.7 16.9 21.4 18.6"></path>
    </svg>`,
  check: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polyline points="5 12 10 17 19 8"></polyline>
    </svg>`,
};

const LABELS = Object.freeze({
  [ZOOM_MODE.FULL]: 'Full Extent Zoom',
  [ZOOM_MODE.DETAIL]: 'Detail Zoom',
  [ZOOM_MODE.CUSTOM]: 'Custom Zoom',
});

let activeCloser = null;

function closeActive(except = null){
  if (typeof activeCloser === 'function' && activeCloser !== except){
    try{ activeCloser(); }catch(_e){}
  }
}

export function createZoomModeControl(opts = {}){
  const title = String(opts.title || 'Timeline zoom mode');
  const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : (() => {});
  const getMode = typeof opts.getMode === 'function' ? opts.getMode : (() => ZOOM_MODE.CUSTOM);
  let currentMode = getMode() || ZOOM_MODE.CUSTOM;

  const root = document.createElement('div');
  root.className = `pfx-zoommode ${opts.className || ''}`.trim();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pfx-zoommode-btn';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = `<span class="pfx-zoommode-btnIcon">${SVG.button}</span><span class="pfx-zoommode-caret">${SVG.chevron}</span>`;

  const menu = document.createElement('div');
  menu.className = 'pfx-zoommode-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const refs = {};
  [ZOOM_MODE.FULL, ZOOM_MODE.DETAIL, ZOOM_MODE.CUSTOM].forEach((mode) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pfx-zoommode-item';
    item.dataset.mode = mode;
    item.setAttribute('role', 'menuitemradio');
    item.innerHTML = `
      <span class="pfx-zoommode-check">${SVG.check}</span>
      <span class="pfx-zoommode-itemIcon">${SVG[mode]}</span>
      <span class="pfx-zoommode-itemLabel">${LABELS[mode]}</span>
    `;
    item.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      currentMode = mode;
      setMode(mode);
      close();
      onSelect(mode);
    });
    refs[mode] = item;
    menu.appendChild(item);
  });

  const sync = () => setMode(getMode() || currentMode);

  const restoreMenuHost = () => {
    try{
      if (menu.parentNode !== root) root.appendChild(menu);
    }catch(_e){}
    menu.classList.remove('is-portal-open');
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.minWidth = '';
    menu.style.maxWidth = '';
    menu.style.zIndex = '';
    menu.style.visibility = '';
    menu.style.opacity = '';
  };

  const positionMenu = () => {
    if (menu.hidden) return;
    try{
      const rect = button.getBoundingClientRect();
      const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
      const desiredMinWidth = Math.max(210, Math.ceil(rect.width) + 42);
      menu.style.minWidth = `${desiredMinWidth}px`;
      menu.style.maxWidth = `min(${Math.max(240, desiredMinWidth + 80)}px, calc(100vw - 16px))`;
      const menuW = Math.max(menu.offsetWidth || desiredMinWidth, desiredMinWidth);
      const menuH = Math.max(menu.offsetHeight || 140, 96);
      let left = rect.left;
      let top = rect.bottom + 7;
      if ((left + menuW) > (viewportW - 8)) left = Math.max(8, viewportW - menuW - 8);
      if ((top + menuH) > (viewportH - 8)) top = Math.max(8, rect.top - menuH - 7);
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    }catch(_e){}
  };

  const mountMenuToBody = () => {
    try{
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
    }catch(_e){}
    menu.classList.add('is-portal-open');
    menu.style.position = 'fixed';
    menu.style.zIndex = '2147483000';
    menu.style.visibility = 'hidden';
    menu.style.opacity = '0';
    menu.hidden = false;
    positionMenu();
    requestAnimationFrame(() => {
      if (menu.hidden) return;
      positionMenu();
      menu.style.visibility = '';
      menu.style.opacity = '';
    });
  };

  const setOpen = (open) => {
    const next = !!open;
    root.classList.toggle('is-open', next);
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next){
      sync();
      mountMenuToBody();
      activeCloser = close;
      return;
    }
    menu.hidden = true;
    restoreMenuHost();
    if (activeCloser === close) activeCloser = null;
  };

  const close = () => setOpen(false);

  const open = () => {
    closeActive(close);
    setOpen(true);
  };

  const toggle = () => {
    if (menu.hidden) open();
    else close();
  };

  const setMode = (mode) => {
    currentMode = (mode && LABELS[mode]) ? mode : ZOOM_MODE.CUSTOM;
    root.dataset.mode = currentMode;
    button.dataset.mode = currentMode;
    button.title = `${title}: ${LABELS[currentMode]}`;
    button.setAttribute('aria-label', `${title}: ${LABELS[currentMode]}`);
    Object.entries(refs).forEach(([key, node]) => {
      const active = key === currentMode;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  };

  button.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggle();
  });

  button.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' '){
      ev.preventDefault();
      ev.stopPropagation();
      open();
    }
  });

  menu.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  menu.addEventListener('click', (ev) => ev.stopPropagation());

  const _onDocPointerDown = (ev) => {
    const target = ev?.target;
    if (root.contains(target) || menu.contains(target)) return;
    close();
  };
  document.addEventListener('pointerdown', _onDocPointerDown, true);

  const _onDocKeyDown = (ev) => {
    if (ev.key === 'Escape') close();
  };
  document.addEventListener('keydown', _onDocKeyDown);

  const _onWinResize = () => positionMenu();
  const _onWinScroll = () => positionMenu();
  window.addEventListener('resize', _onWinResize, { passive: true });
  window.addEventListener('scroll', _onWinScroll, true);

  const destroy = () => {
    close();
    document.removeEventListener('pointerdown', _onDocPointerDown, true);
    document.removeEventListener('keydown', _onDocKeyDown);
    window.removeEventListener('resize', _onWinResize, { passive: true });
    window.removeEventListener('scroll', _onWinScroll, true);
    try{ root.remove(); }catch{}
    try{ menu.remove(); }catch{}
  };

  root.append(button, menu);
  setMode(currentMode);
  root._zoomMode = { open, close, toggle, setMode, sync, destroy };

  return { root, button, menu, open, close, toggle, setMode, sync, destroy };
}
