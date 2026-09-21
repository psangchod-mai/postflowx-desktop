/**
 * pfxPlatform.js — Runtime platform abstraction for PostFlowX.
 *
 * In Chrome Extension:
 *   window.pfxPlatform is undefined; code uses chrome.* APIs directly.
 *
 * In Electron desktop app:
 *   preload.js sets window.pfxPlatform before any scripts run.
 *   All native operations (file I/O, dialogs, companion) go through this.
 *
 * Usage:
 *   const isDesktop = typeof window.pfxPlatform !== 'undefined';
 *   if (window.pfxPlatform?.isMacApp) {
 *     const folder = await window.pfxPlatform.pickFolder();
 *   }
 *
 * This file is a no-op shim — the real pfxPlatform is injected by preload.js.
 * Loading this file in Chrome Extension context is safe and does nothing.
 */

(function () {
  // Build metadata is carried by inert <html data-*> attributes so the desktop
  // Content-Security-Policy can keep blocking executable inline scripts. The
  // renderer build replaces these values for desktop/extension packages; the
  // Electron preload remains authoritative for the live desktop target.
  const buildMeta = document.documentElement?.dataset || {};
  if (!window.__PFX_TARGET__) {
    window.__PFX_TARGET__ = buildMeta.pfxTarget || (window.pfxPlatform?.isMacApp ? 'desktop' : 'extension');
  }
  if (!window.__PFX_BUILD_TIME__) {
    window.__PFX_BUILD_TIME__ = buildMeta.pfxBuildTime || 'development';
  }
  if (!window.__PFX_BUILD_VERSION__) {
    const packagedVersion = buildMeta.pfxBuildVersion;
    const runtimeVersion = window.chrome?.runtime?.getManifest?.()?.version;
    window.__PFX_BUILD_VERSION__ = packagedVersion && packagedVersion !== '0.0.0'
      ? packagedVersion
      : (runtimeVersion || '—');
  }

  // Activate desktop CSS (mac-titlebar, mac-workspace-toolbar rules) as early as possible.
  // preload.js sets pfxPlatform.isMacApp = true before any renderer scripts run.
  if (window.pfxPlatform?.isMacApp) {
    document.documentElement.setAttribute('data-pfx-env', 'desktop');
  }

  // If preload already set pfxPlatform, we're done
  if (window.pfxPlatform) return;

  // Chrome Extension: provide a thin wrapper over chrome.* APIs so call sites
  // can use pfxPlatform without platform-checking every call.
  window.pfxPlatform = {
    isMacApp:    false,
    isExtension: typeof chrome !== 'undefined' && !!chrome.runtime?.id,

    pickFile(opts) {
      // Chrome Extension can't show native file picker from background context;
      // use an <input type="file"> approach or return null.
      return Promise.resolve(null);
    },

    pickFiles(opts) {
      return Promise.resolve([]);
    },

    pickFolder(opts) {
      // Not available in Chrome Extension without native helper
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(
            { type: 'IMF_COMPANION_CALL', payload: { action: 'pickFolder' } },
            (result) => {
              void chrome.runtime.lastError;
              resolve(result?.response?.data?.folderPath || null);
            },
          );
        } else {
          resolve(null);
        }
      });
    },

    saveFile({ defaultPath, data, encoding } = {}) {
      // Chrome Extension: use chrome.downloads
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
          let url;
          try {
            const blob = new Blob([data], { type: 'application/octet-stream' });
            url = URL.createObjectURL(blob);
          } catch { resolve(null); return; }
          chrome.downloads.download(
            { url, filename: defaultPath?.split('/').pop() || 'download', saveAs: true },
            (id) => {
              void chrome.runtime.lastError;
              URL.revokeObjectURL(url);
              resolve(id ? defaultPath : null);
            },
          );
        } else {
          resolve(null);
        }
      });
    },

    readFile() { return Promise.resolve(null); },
    fileExists() { return Promise.resolve(false); },
    revealInFinder() { return Promise.resolve(); },

    openExternal(url) {
      window.open(url, '_blank', 'noopener');
      return Promise.resolve();
    },

    sendNativeCommand(payload, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const tid = setTimeout(
            () => reject(new Error('sendNativeCommand timeout')),
            timeoutMs || 20000,
          );
          chrome.runtime.sendMessage(
            { type: 'IMF_COMPANION_CALL', payload, timeoutMs },
            (result) => {
              clearTimeout(tid);
              void chrome.runtime.lastError;
              if (result?.ok) resolve(result.response);
              else reject(new Error(result?.error?.message || 'companion call failed'));
            },
          );
        } else {
          reject(new Error('No native bridge available'));
        }
      });
    },

    getAppInfo() {
      return Promise.resolve({
        version:  (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || '0',
        platform: 'extension',
        isPackaged: true,
      });
    },

    getURL(p) {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(p);
      }
      return p;
    },
  };
})();
