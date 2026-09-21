# Trailer Conform — UX Improvement Ideas for Non-Technical Users
_Research date: 2026-07-10_

## Summary
Trailer Conform is a mature, single-file panel UI (`src/scripts/features/trlconf/index.js`, ~3.9k lines) with a real 5-step workflow (Inputs → AI Match → Results → Verify → Export), a robust 4×4-grid regional dHash matcher (`pictureMatcher.js`) that already discards corrupted cells (burn-ins/watermarks), and a weighted visual+duration confidence formula with SAFE/REVIEW/FAIL auto-classification. The legacy competing `trailerConform.js` phase-wizard is gone from `src/` (only stale copies remain in git-ignored `dist/*` build output, so it does not clobber anything today). The main gaps for non-technical editors are: raw/technical error copy, no in-UI explanation of what SAFE/REVIEW/FAIL/percentages mean, no bulk-approve for the common "everything matched SAFE" case, and no guardrail summary before export.

## Prioritized Ideas

### 1. Add a one-click "Approve all SAFE" bulk action
- **What to change:** Add a single button in the Results panel header (next to `trcResultsStats`, index.js:1387-1389) that approves every row currently classified `SAFE` in one action, instead of requiring `Approve` clicks per row (index.js:1805-1807, `data-act="approve"`).
- **Why it helps:** Trailer/promo cuts commonly have 60-90%+ of events land as SAFE. Coordinators currently must click through each row individually (only per-row Approve/Reject/Review buttons exist — confirmed no bulk action anywhere in the file). A single "Approve All SAFE" cuts a repetitive, error-prone chore to one click and lets them focus manual attention on REVIEW/FAIL rows.
- **Effort:** S
- **Current behavior (for reference):** index.js:1805-1807 — only per-row `Approve`/`Review`/`Reject` buttons exist; index.js:3515-3543 wires single-event approve/reject click handlers with no "select all" equivalent.

### 2. Translate raw decode/network errors into plain-language guidance
- **What to change:** Replace direct `err.message` dumps (e.g. index.js:2490, 2738, 3391, 3452 — `Error: ${err.message}`) with a small mapping layer that turns known failure classes (companion unreachable, ProRes codec unsupported, proxy timeout, seek timeout) into short actionable sentences, e.g. "Could not read this ProRes file automatically — try relaunching PostFlowX so the background helper can restart" instead of "ProRes not supported by the browser and the companion proxy is unavailable (ECONNREFUSED 127.0.0.1:47125)" (the literal error built at index.js:473).
- **Why it helps:** Editors/coordinators have no context for "companion", "ECONNREFUSED", or "codec unsupported" — these are internal implementation details. A plain-language message with a concrete next step (retry, relaunch, re-export a supported proxy) avoids support tickets and lets non-engineers self-serve.
- **Effort:** M
- **Current behavior (for reference):** index.js:3290-3295 already does a *little* cleanup (`upload_failed_` → `Upload failed`, underscores → spaces) for the Reference QT decode path only — this exists and works, but is not applied consistently to the Auto Match / Index Source error paths (index.js:2490, 2738, 3391, 3452), which still show raw `Error: ${err.message}`.

### 3. Add an inline legend/tooltip explaining SAFE / REVIEW / FAIL and the % columns
- **What to change:** Add a persistent, small legend (or a "?" info popover) near the Results table header explaining: SAFE = high-confidence auto-match, safe to trust; REVIEW = matched but worth a quick visual check; FAIL = no reliable match, needs manual placement; and what Visual %/Audio %/Final % mean in one plain sentence each.
- **Why it helps:** The UI surfaces `SAFE`/`REVIEW`/`FAIL` badges and three separate percentage columns (Visual %, Audio %, Final %, index.js:1408-1410) with zero in-app explanation of the underlying thresholds (82%/58% visual confidence + variance/sample-count rules baked into `_computeRowStatus`, index.js:1663-1669). Non-technical users currently have to guess or ask engineering what "82% visual, 3 samples" actually means for trust in the edit.
- **Effort:** S
- **Current behavior (for reference):** index.js:1385-1420 (Results panel markup) and index.js:1663-1669 (`_computeRowStatus` thresholds) — no legend, tooltip, or help text exists anywhere in the panel.

### 4. Show a pre-export confidence gate / warning banner
- **What to change:** Before enabling the Export buttons, show a warning if `REVIEW Unapproved` or `FAIL` counts are non-zero (these are already computed at index.js:1567-1579 and displayed as summary cards at index.js:1438-1444), e.g. "12 events still need review before export — export anyway?" with a confirm step, rather than silently letting a coordinator export with unresolved REVIEW/FAIL rows sitting there.
- **Why it helps:** The Export panel already computes and displays exactly this data (`reviewUnapproved`, `fail` counts) but takes no action on it — a rushed coordinator can click Export XML without noticing the counts. A gate turns an easily-missed number into an explicit decision point, preventing accidentally shipping an unconformed cut.
- **Effort:** S
- **Current behavior (for reference):** index.js:1438-1444 (summary cards already show REVIEW Unapproved / FAIL) and the export button click handlers (search `trcBtnExportXML`) proceed unconditionally regardless of those counts.

### 5. Auto-advance / auto-focus the next REVIEW or FAIL row after an action
- **What to change:** After Approve/Reject/Mark Review is clicked (in either the Results row actions at index.js:1805-1807 or the Verify panel buttons at index.js:1243-1245), automatically select and scroll to the next `REVIEW` or `FAIL` row in the Verify panel, instead of leaving the coordinator to manually scan the table and click the next row.
- **Why it helps:** The stated workflow is "review the REVIEW/FAIL rows one by one in Verify mode." Today, each decision requires re-scanning a potentially long table to find the next flagged row. Auto-advance turns triage into a fast, linear "look, decide, look, decide" loop — the single highest-leverage change for reducing manual clicks for the specific users this feature targets (coordinators triaging dozens of flagged events).
- **Effort:** M
- **Current behavior (for reference):** index.js:3515-3543 (Approve/Reject click handlers) update `state.matchResults` and re-render but do not change `state.selectedEvId` or scroll position; row selection is a separate, manual click elsewhere in the table.

### 6. Surface source-media coverage/matching gaps before running Auto Match
- **What to change:** In the Inputs panel, when Source ProRes files are dropped, proactively flag proxy clips whose extracted episode number (`_extractEpNum`, index.js:141-165) has no matching source file (`status: 'unmatched'` or `'skip'` in `_buildReelMap`, index.js:940-975) with a clear message like "3 clips in your cut don't have a matching source file — they'll be skipped" rather than only revealing this after running the full match and reading through the Results table.
- **Why it helps:** `_buildReelMap` already classifies every proxy reel as `matched`/`low`/`unmatched`/`skip`, but this is internal state — nothing in the Inputs panel visibly warns the user before they spend time running Auto Match on a set of masters that can't cover the whole cut. Catching it up front saves a full recompute cycle and avoids confusion about why some events came back FAIL.
- **Effort:** S
- **Current behavior (for reference):** index.js:940-975 (`_buildReelMap` computes `status` per proxy but the Inputs panel, index.js:1251-1345, never displays it — only file counts).

### 7. Make the manual nudge control show the resulting frame count, not just deltas
- **What to change:** The Verify panel's `-10f/-1f/+1f/+10f` nudge buttons (index.js:3236-3239 in the markup) only apply relative deltas; add a small running total showing the cumulative nudge applied vs. the original auto-match position (e.g. "Nudged +7f from auto-match") next to the offset readout (`trcWaveOffset`, index.js:1231).
- **Why it helps:** Editors making fine manual corrections currently have no way to tell, at a glance, how far they've drifted from the algorithm's original answer — useful context when deciding whether a "REVIEW" match that needed heavy manual nudging should really be trusted as SAFE.
- **Effort:** S
- **Current behavior (for reference):** index.js:1231 (`trcWaveOffset` shows only the ref/source frame offset, not nudge-from-original delta); nudge buttons at index.js:1236-1239.

### 8. Add a plain-language project-level summary at the top of Results ("What do I need to do?")
- **What to change:** Above the Results table, add one sentence auto-generated from the existing stats (already computed at index.js:1815-1818, e.g. "142 events · 128 SAFE · 11 REVIEW · 3 FAIL") phrased as guidance: "128 of 142 events matched automatically and are ready to approve. 14 need your attention before export."
- **Why it helps:** The raw counter string (`${visibleEvents.length} events · ${safe} SAFE · ${review} REVIEW · ${fail} FAIL`, index.js:1818) is accurate but reads like a debug log, not a status update a coordinator would report to a producer. A guidance sentence reframes the same numbers as an actionable to-do, reducing the cognitive translation step non-technical users currently have to do themselves.
- **Effort:** S
- **Current behavior (for reference):** index.js:1815-1818 (`_renderMatchResults` builds the stats string).

## Notes / things NOT recommended (already covered)
- **Regional/grid-based picture hashing** — already implemented and more sophisticated than assumed: `pictureMatcher.js:1-138` does a 4×4-cell dHash with worst-6-cells-discarded robust distance, specifically to survive timecode/logo burn-ins. No need to add this.
- **Compare modes in Verify (side/wipe/overlay/diff)** — already implemented: index.js:1205-1209 (`Side by Side`/`Wipe`/`Overlay`/`Difference` buttons), fully wired.
- **Confidence label/threshold scheme** — already implemented in two places: `_computeRowStatus` (index.js:1663-1669) for SAFE/REVIEW/FAIL, and `confidenceLabel`/`confidenceColor` in `audioMatcher.js:161-173` for a high/medium/low/none + color scheme. Any change here should be a refinement (see Idea #3) of the *messaging* around these, not a new scheme.
- **Manual nudge control** — already implemented (±1f/±10f buttons, index.js:1236-1239, wired to per-event correction state); Idea #7 above is a refinement (show cumulative drift), not a new control.
- **Legacy `trailerConform.js` phase-wizard clobbering the panel UI** — this file does **not** exist anywhere under `src/`; it is only present in git-ignored `dist/desktop_bak/`, `dist/extension/`, and `dist/desktop_bak/desktop/` build output directories (stale/generated, per `PROJECT_MAP.md` and `CLAUDE.md` which both state `dist/` is generated and never hand-edited). The earlier-reported clobbering bug appears to be resolved/no longer applicable in current `src/`.
- **Per-reel slip / "analyze then slip" workflow** — already implemented (`_computeReelSlips`/`_applyReelSlips`, index.js:878-936) with its own visual slip-confidence chip summary (`_renderSlipSummary`, index.js:1674-1699); not revisited here.
