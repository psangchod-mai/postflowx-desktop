'use strict';

/**
 * main.js — Electron main process for PostFlowX desktop app.
 *
 * Responsibilities:
 *   - Create and manage the main BrowserWindow
 *   - Register all IPC handlers (via ipc.js)
 *   - Start the Python companion subprocess (via companion.js)
 *   - Handle macOS app lifecycle (dock, menu, open-file events)
 */

const { app, BrowserWindow, Menu, shell, nativeTheme, protocol, screen } = require('electron');
const path  = require('path');
const fs    = require('fs');

// Set name before app.whenReady() so userData path and window title are correct
app.setName('PostFlowX');

const ipc          = require('./ipc');
const companion    = require('./companion');
const mediaEngine  = require('./native/media_engine');
const nativeEngine = require('./native/pfx_native_engine');

// Register pfx-media:// as a privileged scheme.
// MUST run before app.whenReady() — Electron requires this to be called synchronously.
mediaEngine.registerScheme();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV   = process.argv.includes('--dev') || !app.isPackaged;

// Read dev bypass flag synchronously before window creation so it can be passed
// as additionalArguments (available in process.argv in preload — no IPC needed).
// Production safety: CI builds always write devAuthBypass:false into authConfig.json.
const _DEV_BYPASS = (() => {
  if (process.env.POSTFLOWX_DEV_AUTH_BYPASS === 'true') return true;
  try {
    const cfgPath = app.isPackaged
      ? path.join(process.resourcesPath, 'authConfig.json')
      : path.join(__dirname, 'authConfig.local.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.devAuthBypass === true;
  } catch { return false; }
})();

// Warn at startup when no Google OAuth client ID is configured and dev bypass is off.
const _AUTH_CONFIG_MISSING = (() => {
  if (_DEV_BYPASS) return false;
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'authConfig.json') : null,
    path.join(__dirname, 'authConfig.local.json'),
    path.join(app.getPath('userData'), 'pfx-auth-config.json'),
    path.join(__dirname, 'generated', 'authConfig.generated.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg?.googleDesktopClientId) return false;
    } catch {}
  }
  return true;
})();

// Renderer index path:
//   Dev   → src/index.html (no build step needed, live source files)
//   Prod  → dist/desktop/index.html (built by `node build-renderer.js --target desktop`)
//
// app.getAppPath() returns the asar root when packaged, APP_ROOT otherwise — both work.
const RENDERER_INDEX = IS_DEV
  ? path.join(APP_ROOT, 'src', 'index.html')
  : path.join(app.getAppPath(), 'dist', 'desktop', 'index.html');

// ── Window state persistence ─────────────────────────────────────────────────
// Saved to <userData>/window-state.json; no npm deps.

function _wsBoundsPath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function _loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(_wsBoundsPath(), 'utf8'));
    if (!s || typeof s !== 'object') return null;
    if (!s.width || s.width < 400 || !s.height || s.height < 300) return null;
    // Reject if saved bounds are entirely off every current display
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return (
        s.x + s.width  > a.x - 50 &&
        s.x             < a.x + a.width  + 50 &&
        s.y + s.height > a.y - 50 &&
        s.y             < a.y + a.height + 50
      );
    });
    return onScreen ? s : null;
  } catch (_) {
    return null;
  }
}

function _saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const isMax = win.isMaximized();
    const isFS  = win.isFullScreen();
    const bounds = (isMax || isFS) ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(_wsBoundsPath(), JSON.stringify({
      x: bounds.x, y: bounds.y,
      width: bounds.width, height: bounds.height,
      maximized: isMax || isFS,
    }));
  } catch (_) {}
}

// ── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Security: disable remote module (not used) ───────────────────────────────

// ── Window creation ──────────────────────────────────────────────────────────

let mainWindow = null;

async function createWindow() {
  const saved   = _loadWindowState();
  const display = screen.getPrimaryDisplay();
  const { width: workW, height: workH } = display.workAreaSize;

  const winOpts = {
    width:  saved?.width  ?? workW,
    height: saved?.height ?? workH,
    minWidth:  1280,
    minHeight: 760,
    resizable:      true,
    fullscreenable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0b0b10',
    // macOS: native window material behind the translucent titlebar
    ...(process.platform === 'darwin' ? {
      vibrancy: 'under-window',
      visualEffectState: 'active',
    } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,              // needed for preload to use require()
      webSecurity: true,
      allowRunningInsecureContent: false,
      webgl: true,
      additionalArguments: _DEV_BYPASS ? ['--pfx-dev-bypass'] : [],
    },
  };
  // Restore saved position only when the bounds were validated on-screen
  if (saved?.x != null && saved?.y != null) {
    winOpts.x = saved.x;
    winOpts.y = saved.y;
  }

  mainWindow = new BrowserWindow(winOpts);

  // Register IPC handlers after window is created
  ipc.register(mainWindow, APP_ROOT);

  // Diagnostics: mirror the renderer console to <userData>/logs/renderer.log on
  // every launch (truncated at startup), so [IMF] decode/timeline logs are
  // captured regardless of how the app was started — no DevTools needed.
  try {
    const _rlogDir = path.join(app.getPath('userData'), 'logs');
    try { fs.mkdirSync(_rlogDir, { recursive: true }); } catch {}
    const _rlogPath = path.join(_rlogDir, 'renderer.log');
    try { fs.writeFileSync(_rlogPath, `=== renderer log ${new Date().toISOString()} ===\n`); } catch {}
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      const lvl = ['log', 'warn', 'error', 'info'][level] || 'log';
      if (process.env.PFX_LOG_RENDERER === '1') console.log(`[renderer:${lvl}] ${message}`);
      try { fs.appendFileSync(_rlogPath, `[${lvl}] ${message}\n`); } catch {}
    });
  } catch {}

  // In dev: clear renderer cache so stale JS/CSS never loads after a source change
  if (IS_DEV) {
    try {
      await mainWindow.webContents.session.clearCache();
      await mainWindow.webContents.session.clearStorageData({
        storages: ['serviceworkers', 'cachestorage'],
      });
    } catch (e) {
      console.warn('[Main] dev cache clear failed:', e.message);
    }
  }

  // Load the renderer. In dev, add a timestamp query param as an extra cache-buster.
  if (IS_DEV) {
    mainWindow.loadFile(RENDERER_INDEX, { query: { ts: String(Date.now()) } });
  } else {
    mainWindow.loadFile(RENDERER_INDEX);
  }

  // Show window only when content is ready (avoids white flash).
  // First launch (no saved state) or previously maximized → maximize before show.
  mainWindow.once('ready-to-show', () => {
    if (!saved || saved.maximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Persist window bounds while the user interacts (but not while maximized/fullscreen)
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      _saveWindowState(mainWindow);
    }
  });
  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      _saveWindowState(mainWindow);
    }
  });
  // Always save on close so maximize/fullscreen state is preserved
  mainWindow.on('close', () => _saveWindowState(mainWindow));

  // Open external links in the system browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (_AUTH_CONFIG_MISSING) {
      mainWindow.webContents.send('pfx:fromMain', {
        type: 'STARTUP_WARNING',
        code: 'AUTH_CONFIG_MISSING',
        message: 'Google OAuth client ID is not configured. Sign-in will not work until authConfig.json is set up with a valid googleDesktopClientId.',
      });
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // Ignore CSP blocks on sub-resources (third-party iframes, embeds)
    if (code === -30 /* ERR_BLOCKED_BY_CSP */ || (url && url !== `file://${RENDERER_INDEX}`)) return;
    console.error('[Main] page load failed:', code, desc);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Second instance: focus existing window ───────────────────────────────────

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Set appearance to match system dark/light mode
  nativeTheme.themeSource = 'dark';

  // Install pfx-media:// protocol handler (must be after app ready).
  mediaEngine.installProtocolHandler();

  createWindow();
  buildMenu();

  // Start native media engine in background — non-blocking
  nativeEngine.start().catch((err) => {
    console.warn('[Main] nativeEngine start error:', err.message);
  });

  // Start companion in background — non-blocking
  companion.start().catch((err) => {
    console.warn('[Main] companion start error:', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS: keep app running until Cmd+Q even with no windows
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  nativeEngine.stop();
  companion.stop();
});

// ── Content Security Policy ───────────────────────────────────────────────────

app.on('web-contents-created', (_e, wc) => {
  // Allow file:// blob: data: and localhost — needed for media/workers/FFmpeg
  wc.session.webRequest.onHeadersReceived(({ responseHeaders }, cb) => {
    cb({
      responseHeaders: {
        ...responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self' file: blob: data:",
            "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' file: blob:",
            "style-src 'self' 'unsafe-inline' file: blob:",
            "img-src 'self' file: blob: data: https:",
            "media-src 'self' file: blob: data: pfx-media: http://127.0.0.1:*",
            "connect-src 'self' file: blob: pfx-media: http://127.0.0.1:* https://api.postflowx.com https://api.anthropic.com https://*.supabase.co",
            "worker-src 'self' file: blob:",
            "frame-src 'self' file: blob: https:",
            "font-src 'self' file: blob: data:",
          ].join('; '),
        ],
      },
    });
  });
});

// ── Application menu ─────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click() {
            mainWindow?.webContents.send('pfx:fromMain', { type: 'OPEN_SETTINGS' });
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click() {
            mainWindow?.webContents.send('pfx:fromMain', { type: 'NEW_PROJECT' });
          },
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click() {
            mainWindow?.webContents.send('pfx:fromMain', { type: 'OPEN_PROJECT' });
          },
        },
        {
          label: 'Save Project',
          accelerator: 'CmdOrCtrl+S',
          click() {
            mainWindow?.webContents.send('pfx:fromMain', { type: 'SAVE_PROJECT' });
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Home',
          accelerator: 'Cmd+Shift+H',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_HOME' }); },
        },
        { type: 'separator' },
        {
          label: 'Pull Prep',
          accelerator: 'Cmd+1',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_TAB', tab: 'prepmark' }); },
        },
        {
          label: 'VFX Pull Workspace',
          accelerator: 'Cmd+2',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_TAB', tab: 'prepmark', sub: 'vfx-pull' }); },
        },
        {
          label: 'Cut Diff',
          accelerator: 'Cmd+3',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_TAB', tab: 'cutdiff2' }); },
        },
        {
          label: 'IMF Validation',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_TAB', tab: 'imf' }); },
        },
        {
          label: 'Render Queue',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_TAB', tab: 'renderq' }); },
        },
        {
          label: 'Settings',
          click() { mainWindow?.webContents.send('pfx:fromMain', { type: 'NAVIGATE_TAB', tab: 'about' }); },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        ...(IS_DEV ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'PostFlowX Documentation',
          click() { shell.openExternal('https://postflowx.com/docs'); },
        },
        {
          label: 'Show Logs',
          click() {
            shell.showItemInFolder(app.getPath('logs'));
          },
        },
        {
          label: 'Companion Status',
          click() {
            mainWindow?.webContents.send('pfx:fromMain', { type: 'SHOW_COMPANION_STATUS' });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
