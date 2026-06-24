
function el(tag, attrs={}, children=[]){
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs||{})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function statusLabel(ui, status){ return ui.statuses[status] || status; }
function sevLabel(ui, sev){ return ui.severities[sev] || sev; }

function kpi(label, value, sub){
  return el("div", { class:"kpi" }, [
    el("div", { class:"label" }, [label]),
    el("div", { class:"value" }, [String(value)]),
    sub ? el("div", { class:"sub" }, [sub]) : null
  ]);
}

function kpiColored(label, value, tone, numVal, sub){
  const toneClass = tone === "danger" && numVal > 0 ? "kpi-danger"
                  : tone === "miss"   && numVal > 0 ? "kpi-miss"
                  : tone === "neutral" ? "kpi-neutral"
                  : "";
  return el("div", { class:`kpi ${toneClass}` }, [
    el("div", { class:"label" }, [label]),
    el("div", { class:"value" }, [String(value)]),
    sub ? el("div", { class:"sub" }, [sub]) : null,
  ]);
}

function readinessKpi(passed, total){
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const cls = pct === 100 ? "score-green" : pct >= 60 ? "score-amber" : "score-red";
  const bar = el("div", { class:"kpiScoreBar" }, [
    el("div", { class:`kpiScoreFill ${cls}`, style:`width:${pct}%` }, [])
  ]);
  return el("div", { class:"kpi" }, [
    el("div", { class:"label" }, ["Readiness"]),
    el("div", { class:`value kpiScoreValue ${cls}` }, [`${pct}%`]),
    el("div", { class:"sub" }, [`${passed} / ${total} ready`]),
    bar
  ]);
}

function formatEvidence(obj){
  if (!obj || typeof obj !== "object") return String(obj ?? "—");
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = k.replace(/^[a-z]+\./, "").replace(/_/g, " ");
    const val = Array.isArray(v) ? v.join(", ") : String(v ?? "—");
    lines.push(`${key}: ${val}`);
  }
  return lines.join("\n");
}

function pill(sev, text){
  const cls = sev === "PASSED" ? "ok" : sev === "ISSUES" ? "warn" : sev === "BLOCKED" ? "bad" : "";
  return el("span", { class: `pill ${cls}` }, [text]);
}

function badgeStatus(status){
  return el("span", { class: `badge status ${status}` }, [status]);
}

function badgeCount(text){
  return el("span", { class:"badge count" }, [text]);
}

function renderDrawer(state, handlers, reqId){
  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("drawerOverlay");
  const close = document.getElementById("drawerClose");
  const tabFix = document.getElementById("tabFix");
  const tabEvidence = document.getElementById("tabEvidence");
  const body = document.getElementById("drawerBody");

  const card = state.run?.cards?.find(c=>c.id===reqId);
  if (!card) return;

  document.getElementById("drawerTitle").textContent = card.title;
  document.getElementById("drawerSub").textContent = `${card.subtitle || ""}`;

  let active = "fix";
  function renderBody(){
    body.innerHTML = "";

    // Quick actions for fixes
    const actions = el("div", { class:"drawerActions" }, [
      el("button", { class:"btn small actionPill actionRescan", type:"button" }, ["Rescan"]),
      el("button", { class:"btn small actionPill actionReupload", type:"button" }, ["Reupload"]),
      el("button", { class:"btn small actionPill actionReopen", type:"button" }, ["Reopen"])
    ]);
    actions.children[0].addEventListener("click", () => handlers.onRescanReq?.(reqId));
    actions.children[1].addEventListener("click", () => handlers.onReuploadReq?.(reqId));
    actions.children[2].addEventListener("click", () => handlers.onReopenReq?.(reqId));
    body.appendChild(actions);
    if (active === "fix") {
      const findings = (card.findings || []).slice().sort((a,b)=>{
        const order = {BLOCKER:0, WARNING:1, FYI:2};
        return (order[a.severity]??9)-(order[b.severity]??9);
      });

      if (findings.length === 0) {
        body.appendChild(el("div", { class:"small" }, ["No issues found."]));
      }

      for (const f of findings) {
        const sev = el("span", { class:`sev ${f.severity}` }, [f.severity]);
        const top = el("div", { class:"issueTop" }, [ el("div", { class:"issueTitle" }, [f.title]), sev ]);

        const what = el("div", { class:"kv" }, [ el("div", { class:"k" }, ["What happened"]), el("div", { class:"v" }, [f.issue?.what || "—"]) ]);
        const why  = el("div", { class:"kv" }, [ el("div", { class:"k" }, ["Why it matters"]), el("div", { class:"v" }, [f.issue?.why || "—"]) ]);
        const fix  = el("div", { class:"kv" }, [ el("div", { class:"k" }, ["How to fix"]), el("div", { class:"v" }, [f.issue?.fix || "—"]) ]);

        const box = el("div", { class:"issue" }, [ top, el("div", { class:"issueBody" }, [what, why, fix]) ]);

        // manual confirm
        if (f.module === "manual_confirm") {
          const isOn = Boolean(state.run?.manual?.[f.id]);
          const btn = el("button", { class:"btn small" }, [isOn ? "Confirmed" : "Confirm"]);
          btn.addEventListener("click", () => handlers.onToggleManual(f.id, !isOn));
          box.appendChild(el("div", { class:"confirm" }, [
            btn,
            el("div", { class:"hint" }, [state.config.ui.labels?.manual_confirm_hint || "Use when you have verified this check is satisfied."])
          ]));
        }

        // manual checklist
        if (f.module === "manual_check" && Array.isArray(f.checklist)) {
          const list = el("div", { class:"checklist" }, []);
          for (const item of f.checklist) {
            const checked = Boolean(state.run?.checklist?.[f.id]?.[item.id]);
            const cb = el("input", { type:"checkbox" });
            cb.checked = checked;
            cb.addEventListener("change", () => handlers.onToggleChecklist(f.id, item.id, cb.checked));
            list.appendChild(el("label", { class:"checkItem" }, [cb, item.label]));
          }
          box.appendChild(list);
        }

        body.appendChild(box);
      }
    } else {
      const findings = card.findings || [];
      const hasEvidence = findings.some(f => f.evidence);
      if (!hasEvidence) {
        body.appendChild(el("div", { class:"small evidenceEmpty" }, ["No evidence captured yet. Run preflight with files assigned to this card to collect evidence."]));
      }

      for (const f of findings) {
        if (!f.evidence) continue;
        const evText = formatEvidence(f.evidence);
        body.appendChild(el("div", { class:"issue" }, [
          el("div", { class:"issueTop" }, [el("div", { class:"issueTitle" }, [f.title]), el("span", { class:`sev ${f.severity}` }, [f.severity])]),
          el("div", { class:"issueBody" }, [
            el("pre", { class:"evidencePre" }, [evText])
          ])
        ]));
      }

      const files = card.files || [];
      const totalFiles = (card.fileCount ?? files.length);
      body.appendChild(el("div", { class:"issue" }, [
        el("div", { class:"issueTop" }, [
          el("div", { class:"issueTitle" }, ["Files"]),
          el("span", { class:"sev FYI" }, [`${totalFiles}`])
        ]),
        el("div", { class:"issueBody" }, [
          el("div", { class:"small" }, [
            files.map(f => f.path).join("\n") + (card.filesTruncated ? `\n… (${totalFiles - files.length} more not shown)` : "")
          ])
        ])
      ]));
    }
  }

  function setActive(which){
    active = which;
    tabFix.classList.toggle("active", active==="fix");
    tabEvidence.classList.toggle("active", active==="evidence");
    renderBody();
  }

  overlay.onclick = () => closeDrawer();
  close.onclick = () => closeDrawer();
  tabFix.onclick = () => setActive("fix");
  tabEvidence.onclick = () => setActive("evidence");

  function closeDrawer(){
    drawer.setAttribute("aria-hidden","true");
  }

  drawer.setAttribute("aria-hidden","false");
  setActive("fix");
}

export function renderApp(state, handlers){
  // Collapse / Expand toggle button state (single red button)
  {
    const btn = document.getElementById("actionCollapseAll");
    if (btn) {
      const expanded = window.__pfxExpanded;
      const hasAnyExpanded = !!(expanded && expanded.size > 0);
      const mode = hasAnyExpanded ? "collapse" : "expand";
      btn.dataset.mode = mode;
      btn.title = mode === "collapse" ? "Collapse all" : "Expand all";
      btn.setAttribute("aria-label", btn.title);
    }
  }

  // Progress bar (bulk import / scan)
  {
    const p = state.progress || null;
    const bar = document.getElementById("progressBar");
    const label = document.getElementById("progressLabel");
    const meta = document.getElementById("progressMeta");
    const fill = document.getElementById("progressFill");
    if (bar && label && meta && fill) {
      const active = !!(p && p.active);
      bar.style.display = active ? "block" : "none";
      bar.setAttribute("aria-hidden", active ? "false" : "true");
      bar.classList.toggle("indeterminate", !!(p && p.indeterminate));
      if (active) {
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
    }
  }

  // Row action menus (Add ▾)
  if (!window.__pfxRowMenuListenerAdded) {
    window.__pfxRowMenuListenerAdded = true;
    window.addEventListener("click", () => {
      const open = window.__pfxOpenRowMenu;
      if (open) {
        open.setAttribute("aria-hidden", "true");
        window.__pfxOpenRowMenu = null;
      }
    });
  }

  // KPIs
  const kpis = document.getElementById("kpis");
  const run = state.run;
  if (kpis) {
    kpis.innerHTML = "";

    const selectedCatsForScope = new Set(Array.isArray(state.settings.selectedCategories) ? state.settings.selectedCategories : []);
    const hasScope = selectedCatsForScope.size > 0;
    const scopeSummary = (() => {
      if (!hasScope || !run?.cards) return null;
      const scoped = run.cards.filter(c => selectedCatsForScope.has(c.category));
      return {
        total: scoped.length,
        passed: scoped.filter(c => c.status === "PASSED").length,
        blockers: scoped.filter(c => c.status === "BLOCKED").length,
        missing: scoped.filter(c => c.status === "NOT_ADDED").length,
      };
    })();

    if (run?.summary) {
      const s = scopeSummary || run.summary;
      kpis.appendChild(readinessKpi(s.passed, s.total));
      kpis.appendChild(kpiColored(state.config.ui.labels?.blockers || "Blockers", hasScope ? `${s.blockers}` : "—", "danger", s.blockers));
      kpis.appendChild(kpiColored(state.config.ui.labels?.missing || "Missing", hasScope ? `${s.missing}` : "—", "miss", s.missing));
      kpis.appendChild(kpiColored(state.config.ui.labels?.files || "Files", `${run.filesCount}`, "neutral", run.filesCount, "selected"));
    } else {
      kpis.appendChild(readinessKpi(0, 0));
      kpis.appendChild(kpiColored(state.config.ui.labels?.blockers || "Blockers", "—", "danger", 0));
      kpis.appendChild(kpiColored(state.config.ui.labels?.missing || "Missing", "—", "miss", 0));
      const activeFiles = state.files.reduce((n,f,i)=> n + (f && !state.disabledFileIdxs?.has(i) ? 1 : 0), 0);
      kpis.appendChild(kpiColored(state.config.ui.labels?.files || "Files", activeFiles, "neutral", activeFiles));
    }
  }

  // Delivery status bar
  {
    const bar = document.getElementById("deliveryBar");
    const pct = document.getElementById("deliveryBarPct");
    const fill = document.getElementById("deliveryBarFill");
    const stats = document.getElementById("deliveryBarStats");
    const chip = document.getElementById("deliveryBarChip");
    if (bar && run?.summary) {
      const s = run.summary;
      const score = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
      const cls = score === 100 ? "green" : score >= 60 ? "amber" : "red";
      if (pct)   pct.textContent = `${score}%`;
      if (fill)  { fill.style.width = `${score}%`; fill.className = `deliveryBarFill ${cls}`; }
      if (stats) stats.textContent = `${s.blockers} blocker${s.blockers !== 1 ? "s" : ""} · ${s.passed} passed · ${s.missing} missing`;
      if (chip) {
        chip.textContent = score === 100 ? "DELIVERY READY" : s.blockers > 0 ? "BLOCKED" : "IN PROGRESS";
        chip.className = `deliveryBarChip ${score === 100 ? "chip-ok" : s.blockers > 0 ? "chip-bad" : "chip-warn"}`;
      }
      bar.setAttribute("aria-hidden", "false");
    } else if (bar) {
      bar.setAttribute("aria-hidden", "true");
    }
  }

  // Categories
  const catList = document.getElementById("catList");
  catList.innerHTML = "";
  const categories = state.config.categories;
  const cards = run?.cards || [];
  const byCat = {};
  for (const [k,label] of Object.entries(categories)) byCat[k] = { label, total:0, blocked:0, issues:0, passed:0, missing:0 };
  for (const c of cards) {
    byCat[c.category].total++;
    if (c.status === "BLOCKED") byCat[c.category].blocked++;
    else if (c.status === "ISSUES") byCat[c.category].issues++;
    else if (c.status === "PASSED") byCat[c.category].passed++;
    else if (c.status === "NOT_ADDED") byCat[c.category].missing++;
  }
  const selectedCats = new Set(Array.isArray(state.settings.selectedCategories) ? state.settings.selectedCategories : []);

  // Scope header actions (All / Clear) should be always visible and not disappear on rerender.
  // They live in the Scope panel header (outside #catList), so we bind once.
  {
    const L = state.config.ui.labels || {};
    const allBtn = document.getElementById("scopeAllBtn");
    const clearBtn = document.getElementById("scopeClearBtn");
    if (allBtn) {
      allBtn.textContent = L.all || "All";
      if (!allBtn.__bound) {
        allBtn.__bound = true;
        allBtn.addEventListener("click", () => handlers.onToggleCategory(null, "all"));
      }
    }
    if (clearBtn) {
      clearBtn.textContent = L.clear || "Clear";
      if (!clearBtn.__bound) {
        clearBtn.__bound = true;
        clearBtn.addEventListener("click", () => handlers.onToggleCategory(null, "clear"));
      }
    }
  }

  for (const [cat, info] of Object.entries(byCat)) {
    const right = el("div", { class:"pills" }, [
      info.blocked ? pill("BLOCKED", `B:${info.blocked}`) : null,
      info.issues ? pill("ISSUES", `W:${info.issues}`) : null,
      info.missing ? pill("NOT_ADDED", `M:${info.missing}`) : null,
      info.passed ? pill("PASSED", `P:${info.passed}`) : null
    ].filter(Boolean));
    const isOn = selectedCats.has(cat);
    const cb = el("input", { type:"checkbox" });
    cb.checked = isOn;
    cb.addEventListener("click", (ev) => ev.stopPropagation());
    cb.addEventListener("change", (ev) => { ev.stopPropagation(); handlers.onToggleCategory(cat, "toggle"); });

    const onlyBtn = el("button", { class:"btn small catOnlyBtn" }, ["Only"]);
    onlyBtn.addEventListener("click", (ev) => { ev.stopPropagation(); handlers.onToggleCategory(cat, "only"); });

    const left = el("div", { class:"catLeft" }, [cb, el("div", { class:"catName" }, [info.label])]);
    const row = el("div", { class:`catItem ${isOn ? "active" : ""}` }, [
      left,
      el("div", { class:"catRight" }, [ right, onlyBtn ])
    ]);
    row.addEventListener("click", () => handlers.onToggleCategory(cat, "toggle"));
    catList.appendChild(row);
  }

  // History
  const history = document.getElementById("history");
  history.innerHTML = "";
  for (const h of (state.runsHistory || []).slice(0, 8)) {
    const when = new Date(h.createdAt).toLocaleString();
    const sum = `Ready: ${h.summary?.passed}/${h.summary?.total} • Blockers: ${h.summary?.blockers} • Missing: ${h.summary?.missing}`;
    const row = el("div", { class:"hrow" }, [
      el("div", { class:"hTop" }, [
        el("div", { class:"hWhen" }, [when]),
        el("div", { class:"hWhen" }, [(h.profile || "").replaceAll("_"," ")])
      ]),
      el("div", { class:"hSum" }, [sum])
    ]);
    row.addEventListener("click", () => {
      // show historical run by replacing current run (read-only)
      state.run = h;
      renderApp(state, handlers);
    });
    history.appendChild(row);
  }

  // Content sub
  const contentSub = document.getElementById("contentSub");
  if (!state.files.some(Boolean)) contentSub.textContent = state.config.ui.labels?.pick_scope_hint || "Pick scope (left), add files/folders, then click Run preflight.";
  else {
    const disabled = state.disabledFileIdxs?.size || 0;
    const activeCount = Math.max(0, state.files.length - disabled);
    const disabledTxt = disabled ? ` (ignored: ${disabled})` : "";
    contentSub.textContent = `Selected files: ${activeCount}${disabledTxt} • List: ${state.settings.profile || "final_delivery"}`;
  }

  // Asset list
  const assetsEl = document.getElementById("assets");
  assetsEl.innerHTML = "";

  // Drop overlay (persist element across renders; re-attach after innerHTML wipe)
  let dropOverlay = assetsEl.__dropOverlay;
  if (!dropOverlay) {
    dropOverlay = el("div", { class:"dropOverlay", "aria-hidden":"true" }, [""]);
    assetsEl.__dropOverlay = dropOverlay;
  }
  dropOverlay.textContent = state.config.ui.labels?.drop_hint || "Drop files onto a package row (or the expanded panel) to add";
  assetsEl.appendChild(dropOverlay);

  // Drag & drop wiring (once)
  if (!assetsEl.__dropBound) {
    assetsEl.__dropBound = true;
    let overRow = null;
    const showOverlay = () => assetsEl.__dropOverlay?.setAttribute("aria-hidden", "false");
    const hideOverlay = () => {
      assetsEl.__dropOverlay?.setAttribute("aria-hidden", "true");
      if (overRow) overRow.classList.remove("dragOver");
      overRow = null;
      assetsEl.classList.remove("dropActive");
    };

    assetsEl.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      assetsEl.classList.add("dropActive");
      showOverlay();

      const row = ev.target?.closest?.("tr.reqRow, tr.reqDetails");
      if (row !== overRow) {
        if (overRow) overRow.classList.remove("dragOver");
        overRow = row || null;
        if (overRow) overRow.classList.add("dragOver");
      }
    });

    assetsEl.addEventListener("dragleave", (ev) => {
      // When leaving the whole container
      if (ev.target === assetsEl) hideOverlay();
    });

    assetsEl.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const row = ev.target?.closest?.("tr.reqRow, tr.reqDetails");
      const reqId = row?.dataset?.reqid || null;
      try {
        if (reqId) await handlers.onDropToReq?.(reqId, ev.dataTransfer);
        else await handlers.onDropBulk?.(ev.dataTransfer);
      } finally {
        hideOverlay();
      }
    });

    window.addEventListener("dragend", hideOverlay);
  }

  // View (Netflix-like)
  const view = document.body.dataset.view || "ALL";

  const search = (document.getElementById("search").value || "").toLowerCase().trim();

  // Series mode flags (used throughout render)
  const _isSeries = state.settings?.projectType === 'series' && parseInt(state.settings?.episodeCount, 10) > 1;
  const _epCount  = _isSeries ? Math.max(1, parseInt(state.settings.episodeCount, 10) || 18) : 1;
  const _selectedEps = window.__pfxSelectedEpisodes || null; // Set<number> or null (= all)

  function matchesFilters(card){
    // Base view
    if (view === "BLOCKERS" && card.status !== "BLOCKED") return false;
    if (view === "MISSING" && card.status !== "NOT_ADDED") return false;
    if (view === "WARNINGS" && card.status !== "ISSUES") return false;
    if (view === "READY" && card.status !== "PASSED") return false;

    // Episode filter (series mode)
    if (_isSeries && _selectedEps && _selectedEps.size > 0 && card.epNum != null && !_selectedEps.has(card.epNum)) return false;

    if (search) {
      const hay = `${card.title} ${card.subtitle}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }

  // Cards to render
  const profile = state.settings.profile || "final_delivery";
  const reqIdsAll = state.config.profiles[profile]?.requirements || [];
  const selectedCatsSet = new Set(Array.isArray(state.settings.selectedCategories) ? state.settings.selectedCategories : []);
  const reqIds = selectedCatsSet.size ? reqIdsAll.filter(id => selectedCatsSet.has(state.config.requirements[id]?.category)) : [];

  let cardsToRender;
  if (_isSeries && run?.cards?.length) {
    // Series: use expanded cards from the run, scope-filtered
    cardsToRender = run.cards.filter(c =>
      !selectedCatsSet.size || selectedCatsSet.has(c.category)
    );
  } else {
    // Standalone: placeholder cards for scope, filled from run where available
    const runCardsById = new Map((run?.cards || []).map(c => [c.id, c]));
    cardsToRender = reqIds.map(id => {
      const existing = runCardsById.get(id);
      if (existing) return existing;
      const req = state.config.requirements[id];
      return { id, category: req.category, group: req.group, title: req.title, subtitle: req.subtitle, status: "NOT_ADDED", files: [], findings: [] };
    });
  }

  // Episode filter panel (series mode)
  {
    const epFilterPanel = document.getElementById("epFilterPanel");
    const epListEl = document.getElementById("epList");
    if (epFilterPanel) {
      epFilterPanel.style.display = _isSeries ? "" : "none";
      if (_isSeries && epListEl) {
        epListEl.innerHTML = "";
        for (let ep = 1; ep <= _epCount; ep++) {
          const isChecked = !_selectedEps || _selectedEps.has(ep);
          const lbl = el("label", { class:"epFilterLabel" }, [
            el("input", { type:"checkbox", "data-ep": String(ep), ...(isChecked ? { checked: "" } : {}) }),
            el("span", { class:"epFilterNum" }, [String(ep)])
          ]);
          lbl.querySelector("input").addEventListener("change", () => {
            const allCbs = Array.from(epListEl.querySelectorAll('input[type="checkbox"]'));
            const checked = allCbs.filter(c => c.checked).map(c => parseInt(c.dataset.ep, 10));
            window.__pfxSelectedEpisodes = (checked.length === 0 || checked.length === _epCount)
              ? null
              : new Set(checked);
            document.getElementById("search")?.dispatchEvent(new Event("change", { bubbles: true }));
          });
          epListEl.appendChild(el("div", { class:"epFilterRow" }, [lbl]));
        }
      }
    }
  }

  // Views — pill tabs
  const viewsList = document.getElementById("viewsList");
  if (viewsList) {
    const L = state.config.ui.labels || {};
    const counts = {
      ALL:      cardsToRender.length,
      BLOCKERS: cardsToRender.filter(c => c.status === "BLOCKED").length,
      WARNINGS: cardsToRender.filter(c => c.status === "ISSUES").length,
      MISSING:  cardsToRender.filter(c => c.status === "NOT_ADDED").length,
      READY:    cardsToRender.filter(c => c.status === "PASSED").length,
    };
    const items = [
      { key: "ALL",      label: L.all      || "All",      count: counts.ALL,      tone: "all"  },
      { key: "BLOCKERS", label: L.blockers || "Blockers",  count: counts.BLOCKERS, tone: "bad"  },
      { key: "WARNINGS", label: L.warnings || "Warnings",  count: counts.WARNINGS, tone: "warn" },
      { key: "MISSING",  label: L.missing  || "Missing",   count: counts.MISSING,  tone: "miss" },
      { key: "READY",    label: L.ready    || "Ready",     count: counts.READY,    tone: "ok"   },
    ];

    if (!document.body.dataset.view) document.body.dataset.view = "ALL";
    const active = document.body.dataset.view || "ALL";

    viewsList.innerHTML = "";
    for (const it of items) {
      const pill = el("button", {
        class: `viewPill ${active === it.key ? "active" : ""} tone-${it.tone}`,
        "data-view": it.key,
        type: "button",
        title: `${it.label}: ${it.count}`,
      }, [
        el("span", { class: "viewPillLabel" }, [it.label]),
        el("span", { class: "viewPillCount" }, [String(it.count)]),
      ]);
      pill.addEventListener("click", () => {
        document.body.dataset.view = it.key;
        document.getElementById("search")?.dispatchEvent(new Event("change", { bubbles: true }));
      });
      viewsList.appendChild(pill);
    }
  }

  // Count badge + subtitle
  const filteredCards = cardsToRender.filter(matchesFilters);
  const reqCount = document.getElementById("reqCount");
  if (reqCount) reqCount.textContent = String(filteredCards.length);
  if (contentSub && cardsToRender.length) {
    const base = contentSub.textContent || "";
    const extra = ` • Showing ${filteredCards.length}/${cardsToRender.length}`;
    if (!base.includes("Showing")) contentSub.textContent = base + extra;
  }

  // Render table
  if (reqIds.length === 0) {
    assetsEl.appendChild(el("div", { class:"reqDetailsBox" }, [
      el("div", { class:"small" }, [state.config.ui.labels?.no_scope || "No categories selected. Use the Scope panel (left) to choose what you want to check."])
    ]));
  } else {
    const expanded = window.__pfxExpanded || (window.__pfxExpanded = new Set());
    const activeId = window.__pfxActiveRow || null;

    // Pending (not yet validated) files added via per-package upload.
    const assignedPathsInRun = new Set();
    for (const c of (run?.cards || [])) for (const f of (c.files || [])) assignedPathsInRun.add(f.path);
    const pendingByReq = {};
    for (const [idxStr, rid] of Object.entries(state.draftAssignments || {})) {
      const idx = Number(idxStr);
      const f = state.files?.[idx];
      if (!f || !rid) continue;
      const path = f.webkitRelativePath || f.name;
      if (assignedPathsInRun.has(path)) continue;
      pendingByReq[rid] = (pendingByReq[rid] || 0) + 1;
    }

    const table = document.createElement("table");
    table.className = "reqTable";

    const thead = document.createElement("thead");
    thead.appendChild(el("tr", {}, [
      el("th", {}, ["Name"]),
      _isSeries ? el("th", { class:"thEp" }, ["Episode"]) : null,
      el("th", {}, ["Category"]),
      el("th", {}, ["Status"]),
      el("th", {}, ["Files"]),
      el("th", {}, ["Issues"]),
      el("th", {}, ["Action"]),
    ].filter(Boolean)));
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    // Sort like Netflix (by Name, then episode number for series)
    const sortedCards = filteredCards.slice().sort((a,b) => {
      const nameA = (a.title || "").toLowerCase();
      const nameB = (b.title || "").toLowerCase();
      if (nameA !== nameB) return nameA.localeCompare(nameB);
      if (_isSeries) {
        const epA = a.epNum ?? 0;
        const epB = b.epNum ?? 0;
        if (epA !== epB) return epA - epB;
      }
      const catA = a.category || "";
      const catB = b.category || "";
      if (catA !== catB) return catA.localeCompare(catB);
      const grpA = (a.group || "").toLowerCase();
      const grpB = (b.group || "").toLowerCase();
      if (grpA !== grpB) return grpA.localeCompare(grpB);
      return 0;
    });

    for (const card of sortedCards) {
      const statusText = card.status;
      const findingCounts = { BLOCKER:0, WARNING:0, FYI:0 };

      const isResolved = (f) => {
        if (!f) return false;
        if (f.module === "manual_confirm") return Boolean(run?.manual?.[f.id]);
        if (f.module === "manual_check") {
          const items = Array.isArray(f.checklist) ? f.checklist : [];
          if (!items.length) return false;
          const st = run?.checklist?.[f.id] || {};
          return items.every(it => !!st[it.id]);
        }
        return false;
      };

      for (const f of (card.findings||[])) {
        if (isResolved(f)) continue;
        findingCounts[f.severity] = (findingCounts[f.severity]||0) + 1;
      }

      const isExpanded = expanded.has(card.id);
      const baseFiles = (card.fileCount ?? card.files?.length ?? 0);
      const pendingFiles = pendingByReq[card.id] || 0;
      const filesDisplay = pendingFiles ? `${baseFiles + pendingFiles} (+${pendingFiles})` : String(baseFiles);
      const dotCls = statusText === "PASSED" ? "dot-ok" : statusText === "ISSUES" ? "dot-warn" : statusText === "BLOCKED" ? "dot-bad" : "dot-muted";
      const catLabel = state.config.categories?.[card.category] || card.category;

      const chev = el("span", { class:"chev", title: isExpanded ? "Collapse" : "Expand" }, [isExpanded ? "▾" : "▸"]);
      chev.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (expanded.has(card.id)) {
          // Collapse: remove the detail row directly — no full re-render needed.
          expanded.delete(card.id);
          chev.textContent = "▸";
          chev.title = "Expand";
          const next = row.nextElementSibling;
          if (next?.classList.contains("reqDetails") && next.dataset.reqid === card.id) next.remove();
        } else {
          // Expand: insert the detail row directly after this row.
          expanded.add(card.id);
          chev.textContent = "▾";
          chev.title = "Collapse";
          const pendingCnt = pendingByReq[card.id] || 0;
          const topFindings = (card.findings || [])
            .filter(f => !isResolved(f))
            .sort((a,b) => ({BLOCKER:0,WARNING:1,FYI:2}[a.severity]??9) - ({BLOCKER:0,WARNING:1,FYI:2}[b.severity]??9))
            .slice(0, 3);

          const findingsList = topFindings.length > 0
            ? el("div", { class:"quickFindings" }, topFindings.map(f =>
                el("div", { class:`quickFinding qf-${f.severity}` }, [
                  el("span", { class:`qfSev sev ${f.severity}` }, [f.severity]),
                  el("span", { class:"qfTitle" }, [f.title])
                ])
              ))
            : el("div", { class:"small qfNone" }, [statusText === "PASSED" ? "All checks passed." : statusText === "NOT_ADDED" ? "No files uploaded yet." : "No active findings."]);

          const details = el("tr", { class:"reqDetails", "data-reqid": card.id }, [
            el("td", { colspan: _isSeries ? "7" : "6" }, [
              el("div", { class:"reqDetailsBox" }, [
                el("div", { class:"reqDetailsGrid" }, [
                  el("div", {}, [
                    el("div", { class:"small" }, ["Quick summary"]),
                    el("div", { style:"margin-top:6px" }, [
                      el("span", { class:`badge status ${statusText}` }, [statusLabel(state.config.ui, statusText)]),
                      el("span", { class:"badge", style:"margin-left:8px"}, [`Files: ${card.fileCount ?? card.files?.length ?? 0}`]),
                      pendingCnt ? el("span", { class:"badge", style:"margin-left:8px" }, [`Pending: ${pendingCnt}`]) : null
                    ].filter(Boolean))
                  ]),
                  el("div", {}, [
                    el("div", { class:"small" }, ["Top findings"]),
                    findingsList
                  ])
                ])
              ])
            ])
          ]);
          row.insertAdjacentElement("afterend", details);
        }
      });

      const firstUnresolved = (card.findings || []).find(f => !isResolved(f) && (f.severity === "BLOCKER" || f.severity === "WARNING"));
      const hintEl = (firstUnresolved && (statusText === "BLOCKED" || statusText === "ISSUES"))
        ? el("div", { class:"reqHint" }, [firstUnresolved.title])
        : null;

      const nameCell = el("div", { class:"reqName" }, [
        chev,
        el("div", { style:"min-width:0" }, [
          el("div", { class:"reqTitle" }, [card.title]),
          el("div", { class:"reqSub" }, [card.subtitle || ""]),
          hintEl
        ])
      ]);

      const row = el("tr", { class: `reqRow ${activeId === card.id ? "active" : ""}`, "data-reqid": card.id, "data-status": statusText }, [
        el("td", {}, [nameCell]),
        _isSeries ? el("td", { class:"cellEp" }, [
          card.epNum != null
            ? el("div", { class:"epCell" }, [
                el("div", { class:"epCellNum" }, [String(card.epNum)]),
                el("div", { class:"epCellName" }, [`Episode ${card.epNum}`])
              ])
            : el("span", { class:"epCellMuted" }, ["—"])
        ]) : null,
        el("td", {}, [el("div", { class:"reqCat" }, [
          el("div", { class:"reqCatMain" }, [catLabel]),
          (card.group ? el("div", { class:"reqCatSub" }, [card.group]) : null)
        ].filter(Boolean))]),
        el("td", { class:"cellStatus", "data-status": statusText }, [
          el("span", { class:`statusDot ${dotCls}` }, []),
          statusLabel(state.config.ui, statusText)
        ]),
        el("td", {}, [filesDisplay]),
        el("td", {}, [
          el("div", { class:"miniMeta" }, [
            findingCounts.BLOCKER ? el("span", { class:"miniBadge badge-blocker" }, [`B:${findingCounts.BLOCKER}`]) : null,
            findingCounts.WARNING ? el("span", { class:"miniBadge badge-warn" }, [`W:${findingCounts.WARNING}`]) : null,
            findingCounts.FYI ? el("span", { class:"miniBadge badge-fyi" }, [`FYI:${findingCounts.FYI}`]) : null,
          ].filter(Boolean))
        ]),
        el("td", {}, [(() => {
          const wrap = el("div", { class:"rowActions" }, []);

          // Per-package upload (no dropdown: avoids overflow clipping)
          const addFolderBtn = el("button", { class:"btn tiny", type:"button", title: (state.config.ui.buttons?.add_folder || "Add folder…") }, ["+Folder"]);
          addFolderBtn.addEventListener("click", (ev) => { ev.stopPropagation(); handlers.onPickForReq?.(card.id, "folder"); });

          const addFilesBtn = el("button", { class:"btn tiny", type:"button", title: (state.config.ui.buttons?.add_files_item || "Add files…") }, ["+Files"]);
          addFilesBtn.addEventListener("click", (ev) => { ev.stopPropagation(); handlers.onPickForReq?.(card.id, "files"); });

          // View / Fix
          const viewBtn = el("button", { class:"btn tiny link", type:"button" }, [state.config.ui.buttons?.view_fix || "View / Fix"]);
          viewBtn.addEventListener("click", (ev) => { ev.stopPropagation(); handlers.onOpenDetail(card.id); });

          wrap.appendChild(addFolderBtn);
          wrap.appendChild(addFilesBtn);
          wrap.appendChild(viewBtn);
          return wrap;
        })()])
      ]);
      row.addEventListener("click", () => {
        // Only update the active-row highlight — no full re-render needed.
        const prev = assetsEl.querySelector("tr.reqRow.active");
        if (prev && prev !== row) prev.classList.remove("active");
        row.classList.add("active");
        window.__pfxActiveRow = card.id;
      });
      tbody.appendChild(row);

      if (isExpanded) {
        const details = el("tr", { class:"reqDetails", "data-reqid": card.id }, [
          el("td", { colspan:"6" }, [
            el("div", { class:"reqDetailsBox" }, [
              el("div", { class:"reqDetailsGrid" }, [
                el("div", {}, [
                  el("div", { class:"small" }, ["Quick summary"]),
                  el("div", { style:"margin-top:6px" }, [
                    el("span", { class:`badge status ${statusText}` }, [statusLabel(state.config.ui, statusText)]),
                    el("span", { class:"badge" , style:"margin-left:8px"}, [`Files: ${card.fileCount ?? card.files?.length ?? 0}`])
                  ])
                ]),
                el("div", {}, [
                  el("div", { class:"small" }, ["Notes"]),
                  el("div", { class:"small" }, ["Open View / Fix to see issue text + fix guide."])
                ])
              ])
            ])
          ])
        ]);

        // If there are pending files, show a small hint.
        if (pendingFiles) {
          const hint = details.querySelector('.reqDetailsGrid > div:first-child > div[style]');
          if (hint) {
            hint.appendChild(el("span", { class:"badge", style:"margin-left:8px" }, [`Pending: ${pendingFiles}`]));
          }
        }
        tbody.appendChild(details);
      }
    }

    table.appendChild(tbody);
    assetsEl.appendChild(table);
  }

  // Unassigned files list (only meaningful when there are files)
  const unassignedEl = document.getElementById("unassigned");
  unassignedEl.innerHTML = "";
  if (state.files.some(Boolean)) {
    // Use run.unassigned indices if available, else compute by checking draftAssignments map in run
    const unIdxs = run?.unassigned || [];

    // Bulk assign bar
    if (unIdxs.length) {
      const bulkSelect = el("select", {}, []);
      bulkSelect.appendChild(el("option", { value:"" }, ["— choose —"]));
      const profile = state.settings.profile || "final_delivery";
      const reqIds = state.config.profiles[profile]?.requirements || [];
      for (const rid of reqIds) {
        const req = state.config.requirements[rid];
        bulkSelect.appendChild(el("option", { value: rid }, [req.title]));
      }
      const bulkBtn = el("button", { class:"btn small" }, [state.config.ui.labels?.assign_all || "Assign all"]);
      bulkBtn.addEventListener("click", () => {
        const rid = bulkSelect.value;
        if (!rid) return alert("Choose an asset card first.");
        handlers.onAssignUnassignedBulk(unIdxs, rid);
        alert("Assigned all. Run preflight again to apply.");
      });
      unassignedEl.appendChild(el("div", { class:"urow bulkRow" }, [
        el("div", { class:"fname bulkLabel" }, [state.config.ui.labels?.assign_all_unassigned_to || "Assign all unassigned to:"]),
        bulkSelect,
        bulkBtn
      ]));
    }

    for (const idx of unIdxs.slice(0, 40)) {
      const f = state.files[idx];
      if (!f) continue;
      const path = f.webkitRelativePath || f.name;

      const select = el("select", {}, []);
      const opt0 = el("option", { value:"" }, ["— choose —"]);
      select.appendChild(opt0);

      const profile = state.settings.profile || "final_delivery";
      const reqIds = state.config.profiles[profile]?.requirements || [];
      for (const rid of reqIds) {
        const req = state.config.requirements[rid];
        select.appendChild(el("option", { value: rid }, [req.title]));
      }

      const btn = el("button", { class:"btn small" }, [state.config.ui.buttons?.assign || "Assign"]);
      btn.addEventListener("click", () => {
        const rid = select.value;
        if (!rid) return;
        handlers.onAssignUnassigned(idx, rid);
        alert("Assigned. Run preflight again to apply.");
      });

      unassignedEl.appendChild(el("div", { class:"urow" }, [
        el("div", { class:"fname" }, [path]),
        select,
        btn
      ]));
    }
  }

  // Drawer event wiring (add once)
  if (!window.__pfxDrawerListenerAdded) {
    window.__pfxDrawerListenerAdded = true;
    window.addEventListener("PFX_OPEN_DETAIL", (e) => {
      const reqId = e.detail?.reqId;
      renderDrawer(state, handlers, reqId);
    });
  }
}
