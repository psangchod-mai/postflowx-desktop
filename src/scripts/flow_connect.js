// scripts/flow_connect.js
// Flow Connect button wiring for VFX Mapping action bar.
//
// Behavior:
// - Click: opens Flow in a new tab.
// - Alt/Option-click: set a custom Flow URL (saved in localStorage).
//   - Enter an empty value to reset to the default URL.

const DEFAULT_FLOW_URL = "https://www.autodesk.com/sg/products/flow-production-tracking/overview";

function getFlowUrl(){
  try{
    const v = (localStorage.getItem("mps.flow.url") || "").trim();
    return v || DEFAULT_FLOW_URL;
  }catch{
    return DEFAULT_FLOW_URL;
  }
}

function setFlowUrl(next){
  const v = String(next || "").trim();
  if (!v) return false;
  try{ localStorage.setItem("mps.flow.url", v); }catch{}
  return true;
}

function clearFlowUrl(){
  try{ localStorage.removeItem("mps.flow.url"); }catch{}
}

function openUrl(url){
  const u = String(url || "").trim() || DEFAULT_FLOW_URL;
  try{
    if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function"){
      chrome.tabs.create({ url: u });
      return;
    }
  }catch{}

  try{ window.open(u, "_blank", "noopener"); }catch{}
}

function wire(){
  const btn = document.getElementById("amfFlowConnect");
  if (!btn) return;

  // prevent duplicate wiring
  if (btn.dataset && btn.dataset.mpsWired === "1") return;
  if (btn.dataset) btn.dataset.mpsWired = "1";

  // Ensure tooltip exists
  if (!btn.getAttribute("title")){
    btn.setAttribute("title", "Open Flow (Alt/Option-click to set URL / empty to reset)");
  }

  btn.addEventListener("click", (e) => {
    // Alt/Option-click sets URL
    if (e && (e.altKey || e.metaKey)){
      const cur = getFlowUrl();
      const next = prompt("Flow URL", cur);
      if (next !== null){
        const v = String(next).trim();
        if (!v) clearFlowUrl();
        else setFlowUrl(v);
      }
      return;
    }
    openUrl(getFlowUrl());
  }, { passive: true });
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", wire, { once: true });
} else {
  wire();
}
