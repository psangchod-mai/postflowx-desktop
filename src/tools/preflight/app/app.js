import { loadConfig } from "./loader.js";
import { buildRun } from "./run.js";
import { renderApp } from "./ui.js";
import { normalizeLocale, preferredLocale } from "./locale.js";

// Chrome extension runtime bridge — works in extension context AND Electron iframe (no chrome runtime).
// Falls back to localStorage so state persists across reloads in the desktop app.
const _ext = {
  async getState() {
    try {
      if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
        const res = await chrome.runtime.sendMessage({ type: 'PFX_GET_STATE' });
        return res?.ok ? (res.data || {}) : {};
      }
    } catch (_) {}
    try { return JSON.parse(localStorage.getItem('_pfx_pf_state') || '{}'); } catch { return {}; }
  },
  async saveSettings(settings) {
    try {
      if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
        await chrome.runtime.sendMessage({ type: 'PFX_SAVE_SETTINGS', settings });
        return;
      }
    } catch (_) {}
    try {
      const d = JSON.parse(localStorage.getItem('_pfx_pf_state') || '{}');
      d.pfx_settings = settings;
      localStorage.setItem('_pfx_pf_state', JSON.stringify(d));
    } catch (_) {}
  },
  async saveRun(run) {
    try {
      if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
        await chrome.runtime.sendMessage({ type: 'PFX_SAVE_RUN', run });
        return;
      }
    } catch (_) {}
    try {
      const d = JSON.parse(localStorage.getItem('_pfx_pf_state') || '{}');
      d.pfx_last_run = run;
      localStorage.setItem('_pfx_pf_state', JSON.stringify(d));
    } catch (_) {}
  },
  async clearAll() {
    try {
      if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
        await chrome.runtime.sendMessage({ type: 'PFX_CLEAR_ALL' });
        return;
      }
    } catch (_) {}
    try { localStorage.removeItem('_pfx_pf_state'); } catch (_) {}
  },
};

const state = {
  config: null,
  settings: { profile: "final_delivery", projectName: "", selectedCategories: null, locale: "en" },
  files: [],
  run: null,
  // UI progress (bulk import / scan)
  progress: null,
  // Manual overrides for file->package assignment (key: fileIdx, value: reqId)
  draftAssignments: {},
  // Files the user has replaced/removed (by index into state.files)
  disabledFileIdxs: new Set(),
  // Current picker target (per-package upload)
  pickerTarget: null,
  runsHistory: [],

  // In-memory folder handles (File System Access API) for per-deliverable rescan.
  folderHandles: {},
  // When set, the next folderPicker selection will replace files for this reqId and auto-run preflight.
  pendingRescanPick: null,
};

function qs(id){ return document.getElementById(id); }

function setText(id, txt){
  const n = document.getElementById(id);
  if (n && txt !== undefined && txt !== null) n.textContent = txt;
}

function paintProgress(){
  const p = state.progress;
  const bar = qs("progressBar");
  const label = qs("progressLabel");
  const meta = qs("progressMeta");
  const fill = qs("progressFill");
  if (!bar || !label || !meta || !fill) return;
  const active = !!(p && p.active);
  bar.style.display = active ? "block" : "none";
  bar.setAttribute("aria-hidden", active ? "false" : "true");
  bar.classList.toggle("indeterminate", !!(p && p.indeterminate));
  if (!active) return;
  label.textContent = p.label || "Working…";
  if (p.indeterminate || !Number.isFinite(p.total) || p.total <= 0) {
    meta.textContent = p.meta || "";
    fill.style.width = "45%";
  } else {
    const pct = Math.max(0, Math.min(100, Math.round((p.current / p.total) * 100)));
    meta.textContent = p.meta || `${p.current}/${p.total} • ${pct}%`;
    fill.style.width = `${pct}%`;
  }
}

function setProgress(p){
  state.progress = { active: true, ...p };
  paintProgress();
}

function clearProgress(){
  state.progress = null;
  paintProgress();
}

function tick(){
  return new Promise((r) => setTimeout(r, 0));
}

function filePath(f){
  if (!f) return "";
  return f.__pfxRelPath || f.webkitRelativePath || f.name || "";
}

function activeFileKey(f){
  return `${filePath(f)}|${f.size}|${f.lastModified}`;
}

function getActiveFileCount(){
  let n = 0;
  for (let i=0; i<state.files.length; i++) {
    if (state.disabledFileIdxs.has(i)) continue;
    if (!state.files[i]) continue;
    n++;
  }
  return n;
}

function indicesForReq(reqId){
  const idxs = new Set();

  // Pending assignments
  for (const [idxStr, rid] of Object.entries(state.draftAssignments || {})) {
    const idx = Number(idxStr);
    if (rid === reqId && Number.isFinite(idx)) idxs.add(idx);
  }

  // From last run
  const card = state.run?.cards?.find(c => c.id === reqId);
  if (card) {
    // Preferred: exact indices (memory-safe runs)
    if (Array.isArray(card.fileIdxs) && card.fileIdxs.length) {
      for (const i of card.fileIdxs) if (Number.isFinite(i)) idxs.add(i);
    } else {
      // Fallback: match by stored paths (older runs)
      const paths = new Set((card.files || []).map(x => x.path));
      if (paths.size) {
        for (let i=0; i<state.files.length; i++) {
          if (state.disabledFileIdxs.has(i)) continue;
          const f = state.files[i];
          if (!f) continue;
          const p = filePath(f);
          if (paths.has(p)) idxs.add(i);
        }
      }
    }
  }
  return Array.from(idxs).filter(i => Number.isFinite(i));
}

function applyDisableIndices(idxs){
  for (const idx of idxs) {
    state.disabledFileIdxs.add(idx);
    delete state.draftAssignments[idx];

    // Release memory: drop reference to the File object once it's disabled/replaced.
    // (Still keeps index stable.)
    try { state.files[idx] = null; } catch(_e) {}
  }
  if (state.run) state.run.disabledFileIdxs = Array.from(state.disabledFileIdxs);
}

function isChecklistComplete(run, finding){
  const items = Array.isArray(finding?.checklist) ? finding.checklist : [];
  if (!items.length) return false;
  const st = run?.checklist?.[finding.id] || {};
  return items.every(it => !!st[it.id]);
}

function isFindingResolved(run, finding){
  if (!finding) return false;
  if (finding.module === "manual_confirm") return !!run?.manual?.[finding.id];
  if (finding.module === "manual_check") return isChecklistComplete(run, finding);
  return false;
}

function computeCardStatus(card, run){
  const fileCount = (card.fileCount ?? card.files?.length ?? 0);
  if (fileCount === 0) return "NOT_ADDED";

  const findings = card.findings || [];
  const hasBlocker = findings.some(f => f.severity === "BLOCKER" && !isFindingResolved(run, f));
  const hasWarning = findings.some(f => f.severity === "WARNING" && !isFindingResolved(run, f));
  if (hasBlocker) return "BLOCKED";
  if (hasWarning) return "ISSUES";
  return "PASSED";
}

function recalcRunSummary(){
  if (!state.run?.cards) return;
  const run = state.run;
  const cards = run.cards;

  // Recompute per-card status using the latest manual/checklist state.
  for (const c of cards) c.status = computeCardStatus(c, run);

  const total = cards.length;
  const passed = cards.filter(c => c.status === "PASSED").length;
  const missing = cards.filter(c => (c.fileCount ?? c.files?.length ?? 0) === 0).length;

  // Count unresolved blocker findings (for KPI/report), including manual_check completion.
  const blockers = cards.reduce((n,c)=> n + (c.findings||[]).filter(f => f.severity==="BLOCKER" && !isFindingResolved(run, f)).length, 0);

  run.summary = { total, passed, blockers, missing };
  run.filesCount = getActiveFileCount();
}

function recomputeUnassigned(){
  if (!state.run) return;
  const assignedIdx = new Set();

  for (const c of (state.run.cards || [])) {
    if (Array.isArray(c.fileIdxs)) {
      for (const idx of c.fileIdxs) assignedIdx.add(idx);
    } else {
      // Fallback for older runs
      const paths = new Set((c.files || []).map(x => x.path));
      for (let i=0; i<state.files.length; i++) {
        if (state.disabledFileIdxs.has(i)) continue;
        const f = state.files[i];
        if (!f) continue;
        const p = filePath(f);
        if (paths.has(p)) assignedIdx.add(i);
      }
    }
  }

  const un = [];
  for (let i=0; i<state.files.length; i++) {
    if (state.disabledFileIdxs.has(i)) continue;
    if (!state.files[i]) continue;
    if (!assignedIdx.has(i)) un.push(i);
  }
  state.run.unassigned = un;
}

async function reopenReq(reqId, { openPicker=false } = {}){
  const idxs = indicesForReq(reqId);
  if (idxs.length) {
    const ok = confirm("Reopen this deliverable? Existing files will be ignored so you can re-upload a replacement.");
    if (!ok) return;
    applyDisableIndices(idxs);
  }

  // Clear the card results in current run (so UI shows Missing until re-scan)
  if (state.run?.cards) {
    const card = state.run.cards.find(c => c.id === reqId);
    if (card) {
      card.files = [];
      card.findings = [];
      card.status = "NOT_ADDED";
    }
  }
  recomputeUnassigned();
  recalcRunSummary();
  render();

  if (openPicker) {
    state.pickerTarget = { reqId, mode: "files" };
    qs("filePicker").click();
  }
}

async function rescanReq(reqId){
  if (!state.files.length) return alert("Add files first.");
  const profile = qs("profileSelect")?.value || state.settings.profile || "final_delivery";
  const cardCat = state.config.requirements?.[reqId]?.category || state.run?.cards?.find(c => c.id === reqId)?.category;
  if (!cardCat) return;

  const tmpSettings = { ...state.settings, profile, projectName: qs("projectName").value.trim(), selectedCategories: [cardCat] };

  const prev = state.run
    ? { ...state.run, draftAssignments: state.draftAssignments, disabledFileIdxs: Array.from(state.disabledFileIdxs) }
    : { draftAssignments: state.draftAssignments, disabledFileIdxs: Array.from(state.disabledFileIdxs) };

  setProgress({ label: "Rescanning…", indeterminate: true, meta: `Category: ${cardCat}` });
  await tick();
  let partial;
  try {
    partial = await buildRun(state.config, tmpSettings, state.files, prev);
  } catch (e) {
    console.error(e);
    alert(`Rescan failed: ${e?.message || e}`);
    return;
  } finally {
    clearProgress();
  }

  // Merge cards (keep existing cards outside this category)
  const map = new Map((state.run?.cards || []).map(c => [c.id, c]));
  for (const c of (partial.cards || [])) map.set(c.id, c);

  // Keep card order by current profile requirement order
  const order = state.config.profiles?.[profile]?.requirements || [];
  state.run = state.run || partial;
  state.run.profile = profile;
  state.run.projectName = tmpSettings.projectName || state.run.projectName || "";
  state.run.createdAt = new Date().toISOString();
  state.run.cards = order.filter(id => map.has(id)).map(id => map.get(id));

  // Preserve / update states
  state.run.manual = partial.manual || state.run.manual || {};
  state.run.checklist = partial.checklist || state.run.checklist || {};
  state.run.disabledFileIdxs = Array.from(state.disabledFileIdxs);

  recomputeUnassigned();
  recalcRunSummary();
  render();

}

async function rescanFolderAndRun(reqId){
  if (!reqId) return;

  // Prefer: rescan from a remembered folder handle (no extra clicks).
  // If no handle yet, prompt once via showDirectoryPicker (when supported).
  let handle = state.folderHandles?.[reqId] || null;

  if (!handle && typeof window.showDirectoryPicker === "function") {
    try {
      handle = await window.showDirectoryPicker({ mode: "read" });
    } catch (e) {
      // User cancelled
      if (e?.name === "AbortError") return;
      console.error(e);
      alert(`Rescan failed: ${e?.message || e}`);
      return;
    }
    if (handle) state.folderHandles[reqId] = handle;
  }

  // If we still don't have a handle, fall back to the hidden folder input.
  if (!handle) {
    state.pendingRescanPick = reqId;
    state.pickerTarget = { reqId, mode: "folder" };
    qs("folderPicker").click();
    return;
  }

  // Collect fresh file list from the folder.
  let fresh = [];
  try {
    fresh = await collectFilesFromDirectoryHandle(handle, { label: "Rescanning folder…", includeRoot: true });
  } catch (e) {
    console.error(e);
    alert(`Rescan failed: ${e?.message || e}`);
    return;
  }

  if (!fresh.length) {
    alert("No files found in the selected folder.");
    return;
  }

  // Replace previous files for this deliverable, then run preflight automatically.
  const oldIdxs = indicesForReq(reqId);
  if (oldIdxs.length) applyDisableIndices(oldIdxs);

  await onFilesPickedToReq(fresh, reqId);
  await rescanReq(reqId);
}


/**
 * Write every static string in index.html from the current config.
 *
 * Split out of init() so a language change can re-run it. Only assignments live
 * here — every addEventListener stays in init(), because this runs again on each
 * change and re-binding a listener each time is how one click becomes four.
 */
function applyStaticLabels() {
  const UI = state.config.ui || {};
  const L = UI.labels || {};
  const B = UI.buttons || {};

  setText("lProject", L.project);
  setText("lProfile", L.profile);
  setText("lLanguage", L.language);

  setText("tScope", L.scope);
  setText("tFilters", L.filters);
  setText("tHistory", L.history);
  setText("tLimitations", L.limitations);
  setText("tAssets", L.assets);
  setText("tUnassigned", L.unassigned);
  setText("tViews", L.views || "Views");

  setText("lblBlockers", L.blockers);
  setText("lblMissing", L.missing);
  setText("lblWarnings", L.warnings);

  const search = qs("search");
  if (search && L.search_placeholder) search.placeholder = L.search_placeholder;

  const unHelp = qs("unassignedHelp");
  if (unHelp && L.unassigned_help) unHelp.textContent = L.unassigned_help;

  const bRun    = qs("runBtn");       if (bRun    && B.run)           bRun.textContent    = B.run;
  const bExport = qs("exportBtn");    if (bExport && B.export_report) bExport.textContent = B.export_report;
  const bReset  = qs("resetBtn");     if (bReset  && B.reset)         bReset.textContent  = B.reset;

  const drawerClose = qs("drawerClose"); if (drawerClose && B.close) drawerClose.textContent = B.close;
  const tabFix = qs("tabFix"); if (tabFix && L.fix_now) tabFix.textContent = L.fix_now;
  const tabEvidence = qs("tabEvidence"); if (tabEvidence && L.evidence_tab) tabEvidence.textContent = L.evidence_tab;
}

/**
 * Switch language in place. Returns the locale actually in effect.
 *
 * The order matters. loadConfig runs *before* anything is mutated, so a failed
 * or partial load leaves the pane exactly as it was rather than half-translated
 * — the user gets no change instead of a broken one.
 *
 * The category keys the scope selection is stored against come from
 * requirements.json, which is not localized; the i18n files override display
 * text only. So state.settings.selectedCategories survives the swap untouched,
 * and re-normalizing it here would be a chance to silently drop a selection for
 * no gain.
 */
async function relocalize(raw) {
  const locale = normalizeLocale(raw);
  if (locale === state.settings.locale) return locale;

  let cfg;
  try {
    cfg = await loadConfig(locale);
  } catch (err) {
    console.warn("Preflight: language change failed, keeping", state.settings.locale, err);
    return state.settings.locale;
  }
  if (!cfg || !cfg.ui) {
    console.warn("Preflight: config for", locale, "loaded empty; keeping", state.settings.locale);
    return state.settings.locale;
  }

  state.settings.locale = locale;
  state.config = cfg;
  try { await _ext.saveSettings(state.settings); } catch (_) {}

  applyStaticLabels();
  render();

  // A finished run's card titles were baked at scan time (run.js:630 copies
  // req.title into the card), so re-rendering alone leaves the results in the
  // old language while the chrome around them changes — the worst of both. The
  // files are still in memory precisely because this did not reload, so the run
  // can simply be redone. This is the payoff for not calling location.reload():
  // after a reload state.files is empty and re-running is not an option at all.
  if (state.run && (state.settings.selectedCategories?.length ?? 0) > 0
      && state.files.some(Boolean)) {
    qs("runBtn")?.click();
  }
  return locale;
}

/**
 * Listen for the app's language.
 *
 * postMessage is the contract (scripts/core/paneLang.js). The storage event is a
 * fallback for the case where the host wrote mps.lang without the broadcast
 * reaching us; it is keyed on mps.lang alone, because reacting to our own
 * settings write would loop.
 */
function listenForLanguage() {
  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (!d || d.type !== "pfx:lang" || !d.lang) return;
    relocalize(d.lang);
  });
  window.addEventListener("storage", (ev) => {
    if (!ev || ev.key !== "mps.lang" || !ev.newValue) return;
    relocalize(ev.newValue);
  });
}

async function init() {
  // Load saved settings + history first (so we can load the correct locale).
  const _initData = await _ext.getState();
  const res = { ok: true, data: _initData };
  if (res?.ok) {
    const { pfx_settings, pfx_runs, pfx_last_run } = res.data || {};
    if (pfx_settings) state.settings = { ...state.settings, ...pfx_settings };
    state.runsHistory = Array.isArray(pfx_runs) ? pfx_runs : [];
    state.run = pfx_last_run || null;
    // Guard against corrupted or schema-changed storage: new Set(non-iterable) throws TypeError.
    const _storedIdxs = state.run?.disabledFileIdxs;
    state.disabledFileIdxs = new Set(Array.isArray(_storedIdxs) ? _storedIdxs : []);
  }

  // Starting language. The title bar's choice wins over whatever this pane last
  // ran as — see preferredLocale() in locale.js for why that order and not the
  // other one. The postMessage from paneLang.js will correct us either way; this
  // only decides what the user sees for the first few hundred milliseconds.
  state.settings.locale = preferredLocale(state.settings.locale);

  // Load config with locale
  state.config = await loadConfig(state.settings.locale);

  // Normalize category selection:
  // - null/undefined => ALL categories selected (safe default)
  // - [] => user chose none (disable run)
  const allCats = Object.keys(state.config.categories || {});
  const normalizeSelectedCategories = (val) => {
    const all = allCats.slice();
    const migrate = (arr) => {
      const set = new Set(arr || []);

      // Legacy category keys -> Netflix Content Hub-style keys
      const mapOne = (oldKey, newKey) => { if (set.has(oldKey)) { set.delete(oldKey); set.add(newKey); } };

      mapOne("PICTURE_MASTER", "PICTURE_MASTERING");
      mapOne("EDITORIAL", "EDITORIAL_LIBRARY");
      mapOne("SERVICING", "PICTURE_MASTERING");
      mapOne("BRANDING", "SOURCE_MATERIALS");
      mapOne("VFX_WRAP", "VISUAL_EFFECTS");
      mapOne("ARCHIVE", "PICTURE_MASTERING");

      // Audio legacy splits -> Sound Mastering umbrella
      const audioKeys = ["AUDIO", "AUDIO_STEMS", "AUDIO_PRINT", "AUDIO_PROJECTS"];
      if (audioKeys.some(k => set.has(k))) {
        for (const k of audioKeys) set.delete(k);
        set.add("SOUND_MASTERING");
      }

      return Array.from(set);
    };
    if (val === null || val === undefined) return all;
    if (Array.isArray(val)) return migrate(val).filter(k => allCats.includes(k));
    return all;
  };
  state.settings.selectedCategories = normalizeSelectedCategories(state.settings.selectedCategories);

  // Persist normalized settings (keeps locale even when Reset clears runs)
  await _ext.saveSettings(state.settings);

  // Profile select
  const select = qs("profileSelect");
  select.innerHTML = "";
  for (const [key, p] of Object.entries(state.config.profiles || {})) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
  select.value = state.settings.profile || (state.config.profiles?.delivery_to_netflix ? "delivery_to_netflix" : "final_delivery");

  qs("projectName").value = state.settings.projectName || "";

  // Project type toggle + episode count
  const _typeToggle  = document.getElementById("pfxTypeToggle");
  const _epCountInput = document.getElementById("pfxEpCount");
  if (_typeToggle) {
    const _lblSA = document.getElementById("pfxTypeLblStandalone");
    const _lblSR = document.getElementById("pfxTypeLblSeries");
    const _syncType = () => {
      const isSeries = _typeToggle.checked;
      _lblSA?.classList.toggle("pfx-type-lbl--on", !isSeries);
      _lblSR?.classList.toggle("pfx-type-lbl--on", isSeries);
      if (_epCountInput) _epCountInput.style.display = isSeries ? "inline-block" : "none";
    };
    _typeToggle.checked = (state.settings.projectType || "standalone") === "series";
    if (_epCountInput) {
      _epCountInput.value = state.settings.episodeCount || 18;
      let _epCountDebounce = null;
      const _onEpCountChange = async () => {
        const val = Math.max(1, parseInt(_epCountInput.value, 10) || 18);
        state.settings.episodeCount = val;
        _epCountInput.value = val;
        await _ext.saveSettings(state.settings);
        if ((state.settings.selectedCategories?.length ?? 0) > 0) {
          qs("runBtn")?.click();
        }
      };
      _epCountInput.addEventListener("input", () => {
        clearTimeout(_epCountDebounce);
        _epCountDebounce = setTimeout(_onEpCountChange, 600);
      });
      _epCountInput.addEventListener("change", () => {
        clearTimeout(_epCountDebounce);
        _onEpCountChange();
      });
    }
    _syncType();
    _typeToggle.addEventListener("change", async () => {
      _syncType();
      state.settings.projectType = _typeToggle.checked ? "series" : "standalone";
      if (_typeToggle.checked && !state.settings.episodeCount) state.settings.episodeCount = 18;
      try { localStorage.setItem("pfx_sm_ep_on", _typeToggle.checked ? "1" : "0"); } catch {}
      await _ext.saveSettings(state.settings);
      try { window.parent.postMessage({ type: "pfx:project-type-changed", projectType: state.settings.projectType }, "*"); } catch {}
      // Clear stale run (series cards in standalone mode or vice versa) and re-render
      state.run = null;
      render();
    });
  }

  // Language. The pane takes the app's language rather than offering its own —
  // see locale.js. What stood here was a picker bound to qs("localeSelect"), an
  // element app/index.html has never contained, so the handler never ran and the
  // six non-English config sets on disk were unreachable.
  listenForLanguage();

  // Localize static labels/buttons.
  applyStaticLabels();

  const search = qs("search");

  const searchClear = qs("searchClear");
  if (searchClear) {
    searchClear.addEventListener("click", () => {
      if (search) search.value = "";
      render();
      search?.focus();
    });
  }

  // Actions menu (lightweight)
  const actionsBtn = qs("actionsBtn");
  const actionsMenu = qs("actionsMenu");
  const actionClearFilters = qs("actionClearFilters");
  const actionCollapseAll = qs("actionCollapseAll");
  const actionImportFolder = qs("actionImportFolder");
  const actionImportFiles = qs("actionImportFiles");
  if (actionsBtn && actionsMenu) {
    actionsBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const isOpen = actionsMenu.getAttribute("aria-hidden") === "false";
      actionsMenu.setAttribute("aria-hidden", isOpen ? "true" : "false");
    });
    window.addEventListener("click", () => actionsMenu.setAttribute("aria-hidden", "true"));
  }
  if (actionClearFilters) {
    actionClearFilters.addEventListener("click", () => {
      document.body.dataset.view = "ALL";
      if (search) search.value = "";
      actionsMenu?.setAttribute("aria-hidden", "true");
      render();
    });
  }
  if (actionCollapseAll) {
    actionCollapseAll.addEventListener("click", () => {
      const expanded = window.__pfxExpanded || (window.__pfxExpanded = new Set());
      if (expanded.size > 0) {
        // Collapse all
        window.__pfxExpanded = new Set();
      } else {
        // Expand all (within current Delivery List + Scope)
        const profileKey = qs("profileSelect")?.value || state.settings.profile || "final_delivery";
        const reqIdsAll = state.config.profiles?.[profileKey]?.requirements || [];
        const selectedCats = new Set(Array.isArray(state.settings.selectedCategories) ? state.settings.selectedCategories : []);
        const reqIds = selectedCats.size
          ? reqIdsAll.filter(id => selectedCats.has(state.config.requirements?.[id]?.category))
          : reqIdsAll;
        window.__pfxExpanded = new Set(reqIds);
      }

      actionsMenu?.setAttribute("aria-hidden", "true");
      render();
    });
  }

  // Bulk import (auto-assign)
  if (actionImportFolder) {
    actionImportFolder.addEventListener("click", () => {
      actionsMenu?.setAttribute("aria-hidden", "true");
      state.pickerTarget = null;
      qs("folderPicker").click();
    });
  }
  if (actionImportFiles) {
    actionImportFiles.addEventListener("click", () => {
      actionsMenu?.setAttribute("aria-hidden", "true");
      state.pickerTarget = null;
      qs("filePicker").click();
    });
  }

  // pickers (bulk + per-package)
  const folderPicker = qs("folderPicker");
  const filePicker = qs("filePicker");
  folderPicker.addEventListener("change", async (e) => {
    const target = state.pickerTarget;
    const picked = e.target.files;

    if (target?.reqId && target?.mode === "folder") {
      // If triggered by the Drawer "Rescan" button: replace files for this deliverable and auto-run.
      const pending = state.pendingRescanPick;
      if (pending && pending === target.reqId && picked && picked.length) {
        state.pendingRescanPick = null;
        const oldIdxs = indicesForReq(target.reqId);
        if (oldIdxs.length) applyDisableIndices(oldIdxs);
        await onFilesPickedToReq(picked, target.reqId);
        await rescanReq(target.reqId);
      } else {
        await onFilesPickedToReq(picked, target.reqId);
      }
    } else {
      await onFilesPicked(picked);
    }

    folderPicker.value = "";
    state.pickerTarget = null;
  });
  filePicker.addEventListener("change", async (e) => {
    const target = state.pickerTarget;
    if (target?.reqId && target?.mode === "files") await onFilesPickedToReq(e.target.files, target.reqId);
    else await onFilesPicked(e.target.files);
    filePicker.value = "";
    state.pickerTarget = null;
  });

  qs("runBtn").addEventListener("click", async () => {
    // Require scope selection (categories) for vendor-by-vendor workflows.
    const cats = state.settings.selectedCategories || [];
    if (!Array.isArray(cats) || cats.length === 0) {
      // Read live rather than from a captured `L` — this closure outlives any
      // number of language changes.
      alert(state.config.ui?.labels?.select_scope_first || "Select at least one category to check (left sidebar).");
      return;
    }

    state.settings.profile = qs("profileSelect").value;
    state.settings.projectName = qs("projectName").value.trim();
    await _ext.saveSettings(state.settings);

    // Progress (large folders can take a while)
    setProgress({
      label: "Running preflight…",
      indeterminate: true,
      meta: `Analyzing ${getActiveFileCount()} files`
    });
    await tick();

    // Build run using any draftAssignments made via per-package uploads or manual assignment.
    const prev = state.run
      ? { ...state.run, draftAssignments: state.draftAssignments, disabledFileIdxs: Array.from(state.disabledFileIdxs) }
      : { draftAssignments: state.draftAssignments, disabledFileIdxs: Array.from(state.disabledFileIdxs) };
    try {
      state.run = await buildRun(state.config, state.settings, state.files, prev);
    } catch (e) {
      console.error(e);
      alert(`Preflight failed: ${e?.message || e}`);
      return;
    } finally {
      clearProgress();
    }
    state.draftAssignments = state.run?.draftAssignments || state.draftAssignments;
    state.disabledFileIdxs = new Set(state.run?.disabledFileIdxs || []);
    recalcRunSummary();
    await _ext.saveRun(minifyRunForStorage(state.run));

    // refresh history
    const _latestData = await _ext.getState();
    state.runsHistory = _latestData?.pfx_runs || [];
    render();
  });

  qs("exportBtn").addEventListener("click", () => exportReport());

  qs("resetBtn").addEventListener("click", async () => {
    state.files = [];
    state.run = null;
    state.draftAssignments = {};
    state.disabledFileIdxs = new Set();
    qs("folderPicker").value = "";
    qs("filePicker").value = "";
    // Clear runs/history only; keep settings (including locale + scope).
    await _ext.clearAll();
    state.runsHistory = [];
    render();
  });

  // search rerender — debounce "input" so typing doesn't rebuild on every keystroke;
  // "change" (fired by view-tab synthetic dispatch) stays immediate.
  let _searchDebounce;
  ["search"].forEach(id => {
    const n = qs(id);
    if (!n) return;
    n.addEventListener("input", () => { clearTimeout(_searchDebounce); _searchDebounce = setTimeout(render, 250); });
    n.addEventListener("change", render);
  });

  // auto start new run if query param new=1
  const url = new URL(location.href);
  if (url.searchParams.get("new") === "1") {
    state.run = null;
    state.files = [];
  }

  render();
}

async function onFilesPicked(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;

  const skipSystem = (f) => {
    const n = (f?.name || "").toLowerCase();
    if (!n) return false;
    if (n.startsWith(".")) return true; // .DS_Store, ._*, etc.
    if (n === "thumbs.db" || n === "desktop.ini") return true;
    return false;
  };
  const pathOf = (f) => f?.__pfxRelPath || f?.webkitRelativePath || f?.name || "";
  const key = (f) => `${pathOf(f)}|${f.size}|${f.lastModified}`;
  const existing = new Set(
    state.files
      .map((f,i) => (f && !state.disabledFileIdxs.has(i)) ? key(f) : null)
      .filter(Boolean)
  );

  let added = 0;
  setProgress({ label: `Importing files…`, current: 0, total: arr.length, meta: `0/${arr.length}` });

  for (let i=0; i<arr.length; i++) {
    const f = arr[i];
    if (skipSystem(f)) continue;
    const k = key(f);
    if (!existing.has(k)) {
      state.files.push(f);
      existing.add(k);
      added++;
    }

    // Update progress every ~100 items to keep UI responsive.
    if ((i+1) % 100 === 0) {
      setProgress({ label: `Importing files…`, current: i+1, total: arr.length, meta: `${i+1}/${arr.length} • added:${added}` });
      await tick();
    }
  }

  clearProgress();
  render();
}

async function onFilesPickedToReq(fileList, reqId){
  const arr = Array.from(fileList || []);
  if (!arr.length) return;

  const skipSystem = (f) => {
    const n = (f?.name || "").toLowerCase();
    if (!n) return false;
    if (n.startsWith(".")) return true;
    if (n === "thumbs.db" || n === "desktop.ini") return true;
    return false;
  };
  const pathOf = (f) => f?.__pfxRelPath || f?.webkitRelativePath || f?.name || "";
  const key = (f) => `${pathOf(f)}|${f.size}|${f.lastModified}`;
  const existing = new Set(
    state.files
      .map((f,i) => (f && !state.disabledFileIdxs.has(i)) ? key(f) : null)
      .filter(Boolean)
  );

  const newIdxs = [];
  let added = 0;
  setProgress({ label: `Importing files…`, current: 0, total: arr.length, meta: `0/${arr.length}` });

  for (let i=0; i<arr.length; i++) {
    const f = arr[i];
    if (skipSystem(f)) continue;
    const k = key(f);
    if (existing.has(k)) continue;
    state.files.push(f);
    newIdxs.push(state.files.length - 1);
    existing.add(k);
    added++;

    if ((i+1) % 100 === 0) {
      setProgress({ label: `Importing files…`, current: i+1, total: arr.length, meta: `${i+1}/${arr.length} • added:${added}` });
      await tick();
    }
  }

  // Remember assignment so this package stays clean (no confusing global pool).
  for (const idx of newIdxs) state.draftAssignments[idx] = reqId;

  clearProgress();
  render();

}

// File System Access API: recursively collect files from a DirectoryHandle.
// Enables true folder re-scan without requiring re-upload each time (when supported).
async function collectFilesFromDirectoryHandle(rootHandle, { label = "Scanning folder…", includeRoot = true } = {}) {
  const files = [];
  if (!rootHandle) return files;

  const skipSystemName = (name) => {
    const n = (name || "").toLowerCase();
    if (!n) return false;
    if (n.startsWith(".")) return true; // .DS_Store, ._*, etc.
    if (n === "thumbs.db" || n === "desktop.ini") return true;
    return false;
  };

  let found = 0;

  async function walk(dirHandle, prefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (skipSystemName(name)) continue;
      if (!handle) continue;

      if (handle.kind === "file") {
        const file = await handle.getFile();
        try { file.__pfxRelPath = `${prefix}${name}`; } catch(_e) {}
        files.push(file);
        found++;
        if (found % 100 === 0) {
          state.progress = { active: true, indeterminate: true, label, meta: `Found ${found}` };
          paintProgress();
          await tick();
        }
      } else if (handle.kind === "directory") {
        await walk(handle, `${prefix}${name}/`);
      }
    }
  }

  setProgress({ label, indeterminate: true, meta: "" });
  await tick();
  try {
    const rootPrefix = includeRoot && rootHandle.name ? `${rootHandle.name}/` : "";
    await walk(rootHandle, rootPrefix);
  } finally {
    clearProgress();
  }

  return files;
}


// Drag & drop ingestion (supports folders via webkitGetAsEntry when available)
async function ingestDataTransfer(dt, reqId=null){
  setProgress({ label: "Collecting files…", indeterminate: true, meta: "" });
  const files = await collectFilesFromDataTransfer(dt);
  if (!files.length) {
    clearProgress();
    return;
  }
  // onFilesPicked* will replace progress with a determinate import bar.
  if (reqId) await onFilesPickedToReq(files, reqId);
  else await onFilesPicked(files);
}

async function collectFilesFromDataTransfer(dt){
  const files = [];
  const items = Array.from(dt?.items || []);

  // Try directory traversal first (Chrome / Edge)
  const hasEntry = items.some(it => typeof it.webkitGetAsEntry === "function");
  if (hasEntry) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      await traverseEntry(entry, "");
    }
  }

  // Fallback: direct files list
  if (!files.length) {
    for (const f of Array.from(dt?.files || [])) files.push(f);
  }
  return files;

  async function traverseEntry(entry, prefix){
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve));
      // Preserve a relative path for UX/assignment/dedup.
      try { file.__pfxRelPath = `${prefix}${file.name}`; } catch(_e) {}
      files.push(file);

      if (files.length % 100 === 0) {
        // Indeterminate progress update
        state.progress = { active: true, indeterminate: true, label: "Collecting files…", meta: `Found ${files.length}` };
        paintProgress();
        await tick();
      }
      return;
    }
    if (entry.isDirectory) {
      const dirPrefix = `${prefix}${entry.name}/`;
      const reader = entry.createReader();
      const entries = await readAllDirectoryEntries(reader);
      for (const e of entries) await traverseEntry(e, dirPrefix);
    }
  }

  async function readAllDirectoryEntries(reader){
    const out = [];
    while (true) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve));
      if (!batch || batch.length === 0) break;
      out.push(...batch);
    }
    return out;
  }
}

function exportReport(){
  const run = state.run;
  if (!run) return alert("No run yet. Please run preflight first.");
  const html = state.config.renderReportHTML(run);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 30000);
}

// Keep stored runs lightweight to avoid Chrome memory/storage blowups on large deliveries.
// (We keep full indices in-memory for the current session.)
function minifyRunForStorage(run){
  if (!run) return run;
  const cards = (run.cards || []).map(c => {
    const out = { ...c };
    // Remove huge arrays that are only valid within this session.
    delete out.fileIdxs;
    return out;
  });

  const slim = { ...run, cards };
  // Unassigned indices can be massive; keep only counts for history.
  slim.unassignedCount = Array.isArray(run.unassigned) ? run.unassigned.length : 0;
  slim.unassigned = [];
  return slim;
}

function render(){
  const catsSelected = Array.isArray(state.settings.selectedCategories) ? state.settings.selectedCategories : [];
  const runBtn = qs("runBtn");
  if (runBtn) runBtn.disabled = catsSelected.length === 0;

  renderApp(state, {
    onToggleCategory: async (catKey, mode="toggle") => {
      const allCats = Object.keys(state.config.categories || {});
      const current = Array.isArray(state.settings.selectedCategories) ? state.settings.selectedCategories.slice() : allCats.slice();
      let next = current;
      if (mode === "only") next = [catKey];
      else if (mode === "all") next = allCats.slice();
      else if (mode === "clear") next = [];
      else {
        const set = new Set(current);
        if (set.has(catKey)) set.delete(catKey);
        else set.add(catKey);
        next = Array.from(set);
      }
      state.settings.selectedCategories = next;
      await _ext.saveSettings(state.settings);
      render();
    },
    onAssignUnassignedBulk: (fileIdxs, reqId) => {
      if (!Array.isArray(fileIdxs) || !reqId) return;
      for (const idx of fileIdxs) state.draftAssignments[idx] = reqId;
      render();
    },
    onAssignUnassigned: (fileIdx, reqId) => {
      state.draftAssignments[fileIdx] = reqId;
      render();
    },
    onPickForReq: async (reqId, mode) => {
      if (mode === "folder" && typeof window.showDirectoryPicker === "function") {
        try {
          const handle = await window.showDirectoryPicker({ mode: "read" });
          if (!handle) return;
          state.folderHandles[reqId] = handle;
          const files = await collectFilesFromDirectoryHandle(handle, { label: "Scanning folder…", includeRoot: true });
          await onFilesPickedToReq(files, reqId);
        } catch (e) {
          if (e?.name !== "AbortError") {
            console.error(e);
            alert(`Folder import failed: ${e?.message || e}`);
          }
        }
        return;
      }

      state.pickerTarget = { reqId, mode };
      if (mode === "folder") qs("folderPicker").click();
      else qs("filePicker").click();
    },

    // Drag & drop
    onDropToReq: async (reqId, dt) => {
      await ingestDataTransfer(dt, reqId);
    },
    onDropBulk: async (dt) => {
      await ingestDataTransfer(dt, null);
    },
    onOpenDetail: (reqId) => {
      const evt = new CustomEvent("PFX_OPEN_DETAIL", { detail: { reqId } });
      window.dispatchEvent(evt);
    },
    onToggleManual: (findingId, value) => {
      if (!state.run) return;
      state.run.manual = state.run.manual || {};
      state.run.manual[findingId] = value;
      recalcRunSummary();
      render();
    },
    onToggleChecklist: (findingId, itemId, value) => {
      if (!state.run) return;
      state.run.checklist = state.run.checklist || {};
      state.run.checklist[findingId] = state.run.checklist[findingId] || {};
      state.run.checklist[findingId][itemId] = value;
      recalcRunSummary();
      render();
    },
    onRescanReq: async (reqId) => {
      await rescanFolderAndRun(reqId);
    },
    onReuploadReq: async (reqId) => {
      await reopenReq(reqId, { openPicker: true });
    },
    onReopenReq: async (reqId) => {
      await reopenReq(reqId, { openPicker: false });
    }
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.target.matches("input,select,textarea,[contenteditable]")) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "r" || ev.key === "R") { ev.preventDefault(); qs("runBtn")?.click(); }
  if (ev.key === "/") { ev.preventDefault(); document.getElementById("search")?.focus(); }
  const viewMap = { "1":"ALL", "2":"BLOCKERS", "3":"WARNINGS", "4":"MISSING", "5":"READY" };
  if (viewMap[ev.key]) {
    document.body.dataset.view = viewMap[ev.key];
    document.getElementById("search")?.dispatchEvent(new Event("change", { bubbles: true }));
  }
});

init();
