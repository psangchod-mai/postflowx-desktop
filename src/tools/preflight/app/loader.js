// Config loader (MV3 / browser-only).
// Loads base config + per-locale UI + per-locale overrides for check issue text / fix guides.

export async function loadConfig(locale = "en") {
  const assetUrl = (name) => new URL(`../config/${name}`, import.meta.url).href;

  const safeJson = async (url, fallback) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return fallback;
      return await r.json();
    } catch (err) {
      console.warn("Preflight config load failed:", url, err);
      return fallback;
    }
  };

  const deepMerge = (base, patch) => {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (
        v && typeof v === "object" && !Array.isArray(v) &&
        out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
      ) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const [ui, checks, reqs, profiles, checksI18n, reqsI18n] = await Promise.all([
    safeJson(assetUrl(`ui_strings.${locale}.json`), await safeJson(assetUrl("ui_strings.en.json"), { ui_language: { locale: "en", statuses:{}, severities:{}, buttons:{}, labels:{}, issue_template:{} } })),
    safeJson(assetUrl("checks.json"), { check_library: {} }),
    safeJson(assetUrl("requirements.json"), { requirements: {}, categories: {}, status_policy: {} }),
    safeJson(assetUrl("profiles.json"), { profiles: {} }),
    safeJson(assetUrl(`checks.i18n.${locale}.json`), { check_library: {} }),
    safeJson(assetUrl(`requirements.i18n.${locale}.json`), { requirements: {}, categories: {} }),
  ]);

  const mergedChecks = deepMerge(checks.check_library, checksI18n.check_library);
  const mergedReqs = deepMerge(reqs.requirements, reqsI18n.requirements);
  const mergedCats = { ...(reqs.categories || {}), ...((reqsI18n && reqsI18n.categories) || {}) };

  const config = {
    ui: ui.ui_language,
    checks: mergedChecks,
    requirements: mergedReqs,
    categories: mergedCats,
    statusPolicy: reqs.status_policy,
    matchers: reqs.matchers || {},
    profiles: profiles.profiles,
  };

  config.renderReportHTML = (run) => {
    const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
    const L = config.ui?.labels || {};
    const isResolved = (f) => {
      if (!f) return false;
      if (f.module === "manual_confirm") return !!run?.manual?.[f.id];
      if (f.module === "manual_check") {
        const items = Array.isArray(f.checklist) ? f.checklist : [];
        if (!items.length) return false;
        const st = run?.checklist?.[f.id] || {};
        return items.every(it => !!st[it.id]);
      }
      return false;
    };

    const rows = (run.cards || []).map((c) => {
      const issues = (c.findings || []).map((f) => {
        const resolved = isResolved(f);
        const opacity = resolved ? "opacity:.55" : "";
        const tag = resolved ? ` <span style="color:#2a9d6f">(confirmed)</span>` : "";
        return `<li style="${opacity}"><b>${esc(f.severity)}</b> — ${esc(f.title)}${tag}<br/><span style="color:#666">${esc(f.issue?.what || "")}</span></li>`;
      }).join("");
      return `<h3>${esc(c.title)} <span style="color:#666">(${esc(c.status)})</span></h3>
        <div style="color:#666">${esc(c.subtitle || "")}</div>
        <div><b>${esc(L.files || "Files")}:</b> ${(c.fileCount ?? (c.files || []).length)}</div>
        ${issues ? `<ul>${issues}</ul>` : `<div style="color:#666">No issues.</div>`}
        <hr/>`;
    }).join("\n");

    return `<!doctype html><html><head><meta charset="utf-8"/><title>Preflight Report</title>
      <style>
        body{font-family:system-ui,Segoe UI,Roboto,Arial; padding:24px; max-width:980px; margin:0 auto}
        .kpis{display:flex; gap:12px; flex-wrap:wrap}
        .kpi{border:1px solid #ddd; border-radius:12px; padding:12px 14px}
        .muted{color:#666}
        @media print{ button{display:none} }
      </style></head><body>
      <h1>Preflight Validator Report</h1>
      <div class="muted">${esc(run.projectName || "")} • ${new Date(run.createdAt).toLocaleString()}</div>
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><div class="muted">${esc(L.ready || "Ready")}</div><div><b>${run.summary.passed}/${run.summary.total}</b></div></div>
        <div class="kpi"><div class="muted">${esc(L.blockers || "Blockers")}</div><div><b>${run.summary.blockers}</b></div></div>
        <div class="kpi"><div class="muted">${esc(L.missing || "Missing")}</div><div><b>${run.summary.missing}</b></div></div>
      </div>
      <div style="margin-top:14px">
        <button onclick="window.print()">Print / Save as PDF</button>
      </div>
      <hr/>
      ${rows}
    </body></html>`;
  };

  return config;
}
