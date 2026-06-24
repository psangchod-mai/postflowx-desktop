
// Preflight Validator - MV3 service worker
// Keeps lightweight routing + storage helpers. Avoid long-running logic.

chrome.runtime.onInstalled.addListener(async () => {
  // Initialize minimal defaults if missing.
  const existing = await chrome.storage.local.get(["pfx_settings", "pfx_runs"]);
  if (!existing.pfx_settings) {
    await chrome.storage.local.set({
      pfx_settings: { profile: "final_delivery", projectName: "", selectedCategories: null, locale: "en" }
    });
  }
  if (!existing.pfx_runs) {
    await chrome.storage.local.set({ pfx_runs: [] });
  }
});

// Simple message router.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    if (msg.type === "PFX_GET_STATE") {
      const data = await chrome.storage.local.get(["pfx_settings", "pfx_runs", "pfx_last_run"]);
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "PFX_SAVE_SETTINGS") {
      await chrome.storage.local.set({ pfx_settings: msg.settings || {} });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "PFX_SAVE_RUN") {
      const { run } = msg;
      const { pfx_runs } = await chrome.storage.local.get(["pfx_runs"]);
      const runs = Array.isArray(pfx_runs) ? pfx_runs : [];
      runs.unshift(run);
      // keep last 30 runs
      const trimmed = runs.slice(0, 30);
      await chrome.storage.local.set({ pfx_runs: trimmed, pfx_last_run: run });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "PFX_CLEAR_ALL") {
      await chrome.storage.local.remove(["pfx_runs", "pfx_last_run"]);
      await chrome.storage.local.set({ pfx_runs: [] });
      sendResponse({ ok: true });
      return;
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // keep message channel open for async
});
