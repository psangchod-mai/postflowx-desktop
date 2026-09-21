(function () {
  const shim = window.__pfxChrome || window.parent?.__pfxChrome || window.opener?.__pfxChrome;
  if (!shim || typeof shim !== 'object') return;
  const existing = (window.chrome && typeof window.chrome === 'object') ? window.chrome : {};
  const merged = { ...existing, ...shim };
  merged.storage      = { ...(existing.storage      || {}), ...(shim.storage      || {}) };
  merged.runtime      = { ...(existing.runtime      || {}), ...(shim.runtime      || {}) };
  merged.tabs         = { ...(existing.tabs         || {}), ...(shim.tabs         || {}) };
  merged.downloads    = { ...(existing.downloads    || {}), ...(shim.downloads    || {}) };
  merged.identity     = { ...(existing.identity     || {}), ...(shim.identity     || {}) };
  merged.notifications= { ...(existing.notifications|| {}), ...(shim.notifications|| {}) };
  merged.alarms       = { ...(existing.alarms       || {}), ...(shim.alarms       || {}) };
  merged.action       = { ...(existing.action       || {}), ...(shim.action       || {}) };
  merged.system       = { ...(existing.system       || {}), ...(shim.system       || {}) };
  merged.scripting    = { ...(existing.scripting    || {}), ...(shim.scripting    || {}) };
  merged.offscreen    = { ...(existing.offscreen    || {}), ...(shim.offscreen    || {}) };

  // The spread above reads chrome.runtime.lastError once and copies the VALUE.
  // preload.js deliberately defines it as a live getter, and spreading flattens
  // that getter into whatever it happened to return at load time — null. Every
  // `if (chrome.runtime.lastError)` in the renderer was therefore dead code in
  // the desktop app: a cancelled download or a failed sendMessage reported
  // nothing at all. Re-install the accessor so it stays live.
  const lastErrorDesc = Object.getOwnPropertyDescriptor(shim.runtime || {}, 'lastError');
  if (lastErrorDesc && typeof lastErrorDesc.get === 'function') {
    Object.defineProperty(merged.runtime, 'lastError', lastErrorDesc);
  }

  window.chrome = merged;
})();
