import { DEFAULT_SETTINGS, runAllRules } from "./rules.js";

const el = (id) => document.getElementById(id);

const fileInput = el("fileInput");
const dropZone = el("dropZone");
const list = el("list");
const resultsPanel = el("results");
const summaryPanel = el("summary");
const emptyState = el("emptyState");
const fileNameEl = el("fileName");

const settingsPanel = el("settings");
const btnSettings = el("btnSettings");
const btnSave = el("btnSave");
const btnClose = el("btnClose");
const activeW = el("activeW");
const activeH = el("activeH");
const arTol = el("arTol");

const btnExport = el("btnExport");
const btnClear = el("btnClear");

let lastReport = null;

function show(element, on = true) {
  if (!element) return;
  element.classList.toggle("hidden", !on);
}

function severityLabel(sev) {
  const map = { error: "ERROR", warn: "WARN", info: "INFO" };
  return map[sev] ?? String(sev ?? "").toUpperCase();
}

function render(findings) {
  list.innerHTML = "";
  for (const f of findings) {
    const li = document.createElement("li");

    const badge = document.createElement("span");
    badge.className = `badge ${f.severity}`;
    badge.textContent = severityLabel(f.severity);

    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = f.message;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${f.ruleId}${f.detail ? " — " + f.detail : ""}`;

    li.appendChild(badge);
    li.appendChild(msg);
    li.appendChild(meta);
    list.appendChild(li);
  }

  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  summaryPanel.innerHTML = `
    <div><strong>Summary:</strong>
      <span class="badge error">ERROR ${counts.error || 0}</span>
      <span class="badge warn">WARN ${counts.warn || 0}</span>
      <span class="badge info">INFO ${counts.info || 0}</span>
    </div>
  `;

  show(summaryPanel, true);
  show(resultsPanel, true);
  show(emptyState, false);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(["dvqcSettings"]);
  const s = { ...DEFAULT_SETTINGS, ...(stored.dvqcSettings ?? {}) };
  activeW.value = s.activeW ?? "";
  activeH.value = s.activeH ?? "";
  arTol.value = String(s.arTol ?? DEFAULT_SETTINGS.arTol);
  return s;
}

async function saveSettingsFromUI() {
  const s = {
    activeW: activeW.value ? Number(activeW.value) : null,
    activeH: activeH.value ? Number(activeH.value) : null,
    arTol: arTol.value ? Number(arTol.value) : DEFAULT_SETTINGS.arTol,
  };
  await chrome.storage.sync.set({ dvqcSettings: s });
  return s;
}

function parseAsXml(rawText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) return null;
  return doc;
}

function parseAsJsonToXmlish(rawText) {
  try {
    const obj = JSON.parse(rawText);
    const doc = document.implementation.createDocument("", "json", null);
    const root = doc.documentElement;

    const add = (parent, key, val) => {
      const node = doc.createElement(String(key));
      if (val === null || val === undefined) {
        node.textContent = "";
      } else if (typeof val === "object") {
        if (Array.isArray(val)) {
          for (const item of val) add(node, "item", item);
        } else {
          for (const [k, v] of Object.entries(val)) add(node, k, v);
        }
      } else {
        node.textContent = String(val);
      }
      parent.appendChild(node);
    };

    for (const [k, v] of Object.entries(obj)) add(root, k, v);
    return doc;
  } catch {
    return null;
  }
}

async function analyzeFile(file) {
  if (!file) return;

  fileNameEl.textContent = file.name;
  const rawText = await file.text();

  // Parse XML first, then JSON fallback
  let doc = parseAsXml(rawText);
  if (!doc) doc = parseAsJsonToXmlish(rawText);

  const settings = await loadSettings();
  const findings = runAllRules({ doc, rawText, settings });

  lastReport = {
    fileName: file.name,
    analyzedAt: new Date().toISOString(),
    settings,
    findings,
  };

  render(findings);
}

function exportJson(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (report.fileName || "dvqc") + ".qc.json";
  a.click();
  URL.revokeObjectURL(url);
}

function resetUI() {
  lastReport = null;
  list.innerHTML = "";
  summaryPanel.innerHTML = "";
  fileNameEl.textContent = "";
  fileInput.value = "";
  show(resultsPanel, false);
  show(summaryPanel, false);
  show(emptyState, true);
}

// ---- UI wiring ----
btnSettings.addEventListener("click", async () => {
  await loadSettings();
  show(settingsPanel, true);
});

btnClose.addEventListener("click", () => show(settingsPanel, false));

btnSave.addEventListener("click", async () => {
  await saveSettingsFromUI();
  show(settingsPanel, false);
  if (fileInput.files?.[0]) await analyzeFile(fileInput.files[0]);
});

btnExport.addEventListener("click", () => {
  if (!lastReport) return;
  exportJson(lastReport);
});

btnClear.addEventListener("click", resetUI);

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) await analyzeFile(file);
});

// Drag & drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files?.[0];
  if (file) await analyzeFile(file);
});

// Allow dropping anywhere on the page
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  // Ignore drops inside the dropZone handler
  if (e.target && dropZone.contains(e.target)) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) await analyzeFile(file);
});

// Initial
loadSettings();
