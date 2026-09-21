export const REQUIRED_ASAR_ENTRIES = Object.freeze([
  '/dist/desktop/index.html',
  '/dist/desktop/scripts/ui.js',
  '/dist/desktop/scripts/prep_mark.js',
  '/dist/desktop/scripts/core/pullPrepHealth.js',
  '/electron/main.js',
  '/electron/preload.js',
  '/package.json',
]);

export const REQUIRED_NATIVE_ENTRIES = Object.freeze([
  'electron/native/avf_bridge',
  'electron/native/pfx_native_media_engine',
]);

export function assessAsarInventory(entries = [], required = REQUIRED_ASAR_ENTRIES) {
  const inventory = new Set(entries.map(entry => String(entry).replace(/\\/g, '/')));
  const missing = required.filter(entry => !inventory.has(entry));
  return { ok: missing.length === 0, missing, totalEntries: inventory.size };
}

export function classifyMacSignature(detail = '', spctlAccepted = false) {
  const text = String(detail);
  const adhoc = /Signature=adhoc|flags=.*adhoc/i.test(text);
  const hardenedRuntime = /flags=.*runtime/i.test(text);
  const developerId = /Authority=Developer ID Application:/i.test(text) && !adhoc;
  return {
    mode: developerId ? 'developer-id' : adhoc ? 'ad-hoc' : 'unknown',
    hardenedRuntime,
    gatekeeperAccepted: Boolean(spctlAccepted),
    distributionReady: developerId && hardenedRuntime && Boolean(spctlAccepted),
  };
}

export function summarizePackagedApp({ inventory, native, metadata, codesign, signature }) {
  const localReady = Boolean(
    inventory?.ok
    && native?.ok
    && metadata?.ok
    && codesign?.ok
    && signature?.hardenedRuntime
  );
  return {
    localReady,
    distributionReady: localReady && Boolean(signature?.distributionReady),
    inventory,
    native,
    metadata,
    codesign,
    signature,
  };
}
