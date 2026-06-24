
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
const sevClass = (sev) => {
  const s = String(sev||"").toUpperCase();
  if (s === "OK" || s === "PASS") return "sev-ok";
  if (s === "WARN" || s === "WARNING") return "sev-warn";
  if (s === "FAIL" || s === "ERROR" || s === "REJECT") return "sev-fail";
  return "sev-info";
};
const badge = (sev) => `<span class="badge ${sevClass(sev)}">${esc(sev || "INFO")}</span>`;

function render(payload){
  const root = document.getElementById("root");
  if (!payload || !payload.report) {
    root.innerHTML = `<div class="card"><div class="k">Status</div><div class="v">No report data found</div><div class="small">Go back to BWAV Inspector and click <b>Export PDF</b> again.</div></div>`;
    return;
  }
  const report = payload.report;
  const rows = Array.isArray(payload.rows) ? payload.rows : (report.labelChecks || []);
  const now = new Date();
  const ts = now.toISOString().replace("T"," ").replace(/\..*$/,"");
  const fileName = report?.file?.name || "BWAV";
  const kind = report?.kind || "BWAV";

  const totals = {
    pass: rows.filter(r=>r.status==="PASS").length,
    warn: rows.filter(r=>r.status==="WARN").length,
    reject: rows.filter(r=>r.status==="REJECT").length,
    total: rows.length
  };

  const labelRows = rows.map(r => {
    const mapped = (r.mapped || "") + (r.subgroup ? ` / ${r.subgroup}` : "");
    return `<tr class="${sevClass(r.status)}">
      <td>${badge(r.status)}</td>
      <td>${esc(r.rawLabel)}</td>
      <td>${esc(mapped)}</td>
      <td>${esc(r.source||"")}</td>
      <td class="fix">${esc(r.fix||"")}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5">No label entries.</td></tr>`;

  root.innerHTML = `
    <div class="hdr">
      <div>
        <div class="title">BWAV Inspector — Label Report</div>
        <div class="sub"><b>File:</b> ${esc(fileName)} • <b>Type:</b> ${esc(kind)} • <b>Generated:</b> ${esc(ts)}</div>
      </div>
      <div class="meta">
        <div><b>Labels</b></div>
        <div class="badges">
          <span class="badge sev-ok">PASS ${totals.pass}</span>
          <span class="badge sev-warn">WARN ${totals.warn}</span>
          <span class="badge sev-fail">REJECT ${totals.reject}</span>
          <span class="badge sev-info">TOTAL ${totals.total}</span>
        </div>
      </div>
    </div>

    <h2>Label Checks</h2>
    <table>
      <thead>
        <tr><th>Status</th><th>Raw label</th><th>Mapped</th><th>Source</th><th>Fix</th></tr>
      </thead>
      <tbody>${labelRows}</tbody>
    </table>

    <div class="small" style="margin-top:12px;color:#555;">
      Tip: Use “Export JSON” in the extension for machine-readable output. This page is for printing / Save as PDF.
    </div>
  `;

  // Attempt auto-print, but user can always click the button.
  setTimeout(()=>{ try{ window.print(); }catch{} }, 350);
}

async function loadPayload(){
  // Extension context
  try {
    if (globalThis.chrome?.storage?.local?.get) {
      const data = await chrome.storage.local.get(["bwavInspector_pdfPayload"]);
      return data.bwavInspector_pdfPayload || null;
    }
  } catch (_) {}

  // Standalone web context fallback
  try {
    const raw = localStorage.getItem("bwavInspector_pdfPayload");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {}
  return null;
}

document.getElementById("btnPrint").addEventListener("click", ()=>window.print());
document.getElementById("btnRefresh").addEventListener("click", async ()=>{
  const payload = await loadPayload();
  render(payload);
});

loadPayload().then(render);
