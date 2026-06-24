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
  window.chrome = merged;
})();
