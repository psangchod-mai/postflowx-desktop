
async function openApp(fresh=false){
  const url = chrome.runtime.getURL("../app/index.html" + (fresh ? "?new=1" : ""));
  await chrome.tabs.create({ url });
  window.close();
}

function fmtSummary(run){
  if(!run) return "No runs yet. Click New run to start.";
  const blockers = run.summary?.blockers ?? 0;
  const missing = run.summary?.missing ?? 0;
  const passed = run.summary?.passed ?? 0;
  const total = run.summary?.total ?? 0;
  const when = new Date(run.createdAt).toLocaleString();
  return `Last run: ${when}\nReady: ${passed}/${total} • Blockers: ${blockers} • Missing: ${missing}`;
}

document.getElementById("openApp").addEventListener("click", () => openApp(false));
document.getElementById("newRun").addEventListener("click", () => openApp(true));

(async () => {
  const res = await chrome.runtime.sendMessage({ type: "PFX_GET_STATE" });
  const last = res?.data?.pfx_last_run || null;
  document.getElementById("summary").textContent = fmtSummary(last);
})();
