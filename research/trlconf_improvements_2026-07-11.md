# Trailer Conform — UX Improvement Ideas for Non-Technical Users
_Research date: 2026-07-11 (follow-up to 2026-07-10 pass)_

## Summary
Since yesterday's pass, idea #1 from `trlconf_improvements_2026-07-10.md` ("Add a one-click
'Approve all SAFE' bulk action") shipped: `#trcBtnApproveAllSafe` now lives in the Results
panel header (`src/scripts/features/trlconf/index.js:1390`), its visibility/count is computed
in `_renderMatchResults()` (`index.js:1822-1831`), and its click handler bulk-approves all
visible SAFE rows (`index.js:3527-3539`). `research/trlconf_audit_2026-07-10.md` already
flagged that this button isn't hidden by the early-return branch of `_renderMatchResults()`
when the visible event list becomes empty (`index.js:1713-1719` returns before reaching
1822) — that's a known small polish item, not re-proposed here as new.

Re-reading the current code with that change in mind surfaced two genuinely new findings not
on the prior list: (1) there is still no way to filter/scope the Results table to just the
rows that need attention (REVIEW/FAIL) — the table always renders every visible event
(`index.js:1726`), so on a long cut a coordinator must scroll past everything that's already
SAFE; and (2) when Source ProRes indexing fails for a file, the only trace of *which* file
failed is a `console.warn` (`index.js:3447`) — the UI only ever shows a bare count with
"see console" (`index.js:2878`, `index.js:3456`), which is meaningless to a non-technical
user who doesn't know what a browser console is or how to open one.

The remaining un-implemented ideas from 2026-07-10 (#2–#8) are still valid and are carried
forward below (marked as such) — none were duplicated verbatim; several are re-prioritized
given that bulk-approve now exists, which raises the stakes on the pre-export gate (idea #1
below) since a coordinator can now blast through approvals in one click and is *more* likely
to miss lingering REVIEW/FAIL rows before export than before.

## Prioritized Ideas

### 1. Add a pre-export confidence gate / warning banner before Export XML
- **What to change:** Before running `_exportCorrectedXML()` (`index.js:2900`, wired at
  `index.js:3509` `_$('trcBtnExportXML')?.addEventListener('click', _exportCorrectedXML)`),
  check the already-computed `reviewUnapproved`/`fail` counts (`_getExportSummaryData()`,
  displayed at `index.js:1438-1444` via `trcSumReviewUnapproved`/`trcSumFail`) and show a
  confirmation banner/dialog if either is non-zero, e.g. "12 events still need review before
  export — export anyway?" instead of proceeding unconditionally.
- **Why it helps:** This is now the single highest-leverage gap: the new "Approve All SAFE"
  button (`index.js:1390`, `3527-3539`) makes it a one-click habit to approve everything
  algorithmically SAFE and move straight to Export, which makes it *easier* than before to
  forget the REVIEW/FAIL rows that still need a human look. The Export panel already
  computes and displays exactly the numbers needed to warn — it just never acts on them.
- **Effort:** S
- **Current behavior:** `index.js:3509` calls `_exportCorrectedXML` directly with no gate;
  `_exportCorrectedXML` (`index.js:2900-2965`) has no check against `reviewUnapproved`/`fail`.
- **Carries over from 2026-07-10 (idea #4), re-prioritized to #1** given the bulk-approve
  button that shipped since then.

### 2. Add a status filter (All / SAFE / REVIEW / FAIL) above the Results table
- **What to change:** Add a small segmented control or tab row in `.trc-panel-head` next to
  `#trcResultsStats`/`#trcBtnApproveAllSafe` (`index.js:1387-1390`) that filters which rows
  `_renderMatchResults()` renders into `#trcResultsBody` — currently it always iterates every
  entry from `_getVisibleEvents()` (`index.js:1705`, used again unconditionally at `1726`)
  with zero scoping.
- **Why it helps:** On a 100+ event trailer cut where 85 rows are already SAFE, a coordinator
  triaging REVIEW/FAIL rows currently has to scroll through the whole table to find them. A
  one-click "Show REVIEW + FAIL only" filter turns the table into a worklist instead of a
  full dump — directly complements the new bulk-approve button (approve all SAFE, then filter
  down to just what's left) without requiring any new matching logic.
- **Effort:** S/M (pure render-layer change — filter `visibleEvents` before the `.map()` at
  `index.js:1726`, keep `_getVisibleEvents()` itself untouched since export/summary logic
  depends on the unfiltered list).
- **Current behavior:** No filter/search/sort mechanism exists anywhere in the file (confirmed
  via full-file grep for `filter`/`sort`/`search` — the only table-row filtering is the
  disabled/non-video event exclusion in `_getVisibleEvents()`, `index.js:1534-1536`).
- **New this pass.**

### 3. Show failed source file names inline instead of "see console"
- **What to change:** In the "Index Source Frames" handler (`index.js:3410-3457`), each
  decode failure is caught and only `console.warn`'d with the filename
  (`index.js:3445-3448`: `console.warn('[TrlConform] Failed to index source file', f.name,
  indexErr.message)`); the on-screen status only ever shows a bare count
  (`index.js:3456`: `` `${failed} file(s) could not be decoded — see console` ``, and the
  identical pattern in the Build-Fingerprints-adjacent indexing path at `index.js:2878`).
  Collect the failed filenames into an array during the loop and render them (e.g. as a small
  list under the Source ProRes card, or in the existing `trcSourceInfoStatus` line) instead of
  telling the user to open a console.
- **Why it helps:** "See console" is meaningless instruction for a video editor/coordinator —
  they don't have devtools open and often don't know how to open it. Naming the actual files
  that failed (e.g. "Could not read: REEL_204_B.mov, REEL_207_C.mov") lets them immediately
  know which physical files to re-export/re-transcode, with zero engineering involvement.
- **Effort:** S
- **New this pass.**

### 4. Auto-advance to the next REVIEW or FAIL row after an approve/reject/review action
- **What to change:** After a decision is made — either in the Results row actions
  (`index.js:3657-3700`, the `data-act` delegated handler for `approve`/`review`/`reject`) or
  the Verify panel buttons (`trcBtnApproveMatch`/`trcBtnRejectMatch`/`trcBtnMarkReview`,
  wired at `index.js:3542-3578`) — automatically call `_selectRow()` on the next unresolved
  `REVIEW`/`FAIL` row (by index order) instead of leaving `state.selectedEvId` untouched.
- **Why it helps:** Once idea #2 above (or the existing table) narrows a coordinator down to
  just the rows needing attention, the fastest possible workflow is "look at frame → decide →
  next row appears automatically." Today every decision requires manually re-clicking a row
  in the table; auto-advance turns triage into a continuous loop with no repeated table
  navigation.
- **Effort:** M
- **Carries over from 2026-07-10 (idea #5), unchanged priority-wise (still one of the two
  highest-value un-implemented ideas).**

### 5. Add an inline legend/tooltip for SAFE / REVIEW / FAIL and the % columns
- **What to change:** Add a small persistent legend or "?" info popover near the Results
  table header (`index.js:1385-1391`) explaining SAFE/REVIEW/FAIL in one plain sentence each,
  and what Visual %/Audio %/Final % (`index.js:1408-1410`, computed via `_computeRowStatus`
  thresholds at `index.js:1658-1671`) mean for trust in a match.
- **Why it helps:** The three percentage columns and three status badges have no in-app
  explanation anywhere; a coordinator has to guess or ask engineering what "REVIEW, 71%
  visual" implies about whether it's safe to trust.
- **Effort:** S
- **Carries over from 2026-07-10 (idea #3), unchanged.**

### 6. Surface source-media coverage gaps in the Inputs panel before Auto Match
- **What to change:** `_buildReelMap()` (`index.js:940-975`) already classifies every proxy
  reel as `matched`/`low`/`unmatched`/`skip` per-episode, but the Inputs panel
  (`index.js:1313-1338`, the Source ProRes card) only ever shows file counts
  (`trcSourceInfoCount`/`trcSourceInfoIndexed`/`trcSourceInfoDur`/`trcSourceInfoStatus`) —
  never the reel-map coverage. Add a short warning line once both the cut and source files
  are loaded, e.g. "3 clips in your cut have no matching source file and will be skipped."
- **Why it helps:** Catches an unfixable-at-match-time problem (missing source coverage)
  before a coordinator spends the time running the full Auto Match + Slip pass, rather than
  discovering it only after reading through FAIL rows in Results.
- **Effort:** S
- **Carries over from 2026-07-10 (idea #6), unchanged.**

### 7. Translate raw decode/network errors into plain-language guidance
- **What to change:** Replace direct `` `Error: ${err.message}` ``/`` `Index error:
  ${err.message}` `` dumps (`index.js:2502`, `2750`, `3403`, `3464`) with a small mapping
  layer for known failure classes (companion unreachable, codec unsupported, proxy timeout)
  into short actionable sentences with a concrete next step, matching the pattern that
  already exists for the Reference QT decode path (`index.js:3290-3295` cleans up
  `upload_failed_` style errors) but is not applied to Auto Match / Index Source paths. Fold
  in the "see console" case from idea #3 above as another instance of the same underlying gap
  (raw/internal detail surfaced instead of user-facing guidance).
- **Why it helps:** Editors/coordinators have no context for "ECONNREFUSED", "companion", or
  stack-trace-shaped messages — plain language with a next step (retry, relaunch, re-export a
  supported proxy) avoids support tickets and lets non-engineers self-serve.
- **Effort:** M
- **Carries over from 2026-07-10 (idea #2), broadened slightly to note the related
  "see console" instance found this pass (see idea #3, which should ship first/independently
  since it's smaller).**

### 8. Add a plain-language project-summary sentence above the Results table
- **What to change:** Above/alongside the existing raw stats string built in
  `_renderMatchResults()` (`index.js:1815-1820`, e.g. "142 events · 128 SAFE · 11 REVIEW · 3
  FAIL"), add one auto-generated guidance sentence: "128 of 142 events matched automatically
  and are ready to approve. 14 need your attention before export."
- **Why it helps:** Reframes the same numbers as an actionable to-do rather than a debug-log
  style counter, saving the coordinator the mental translation step and giving them a sentence
  they could paste directly into a status update to a producer.
- **Effort:** S
- **Carries over from 2026-07-10 (idea #8), unchanged.**

## Notes / already covered
- **"Approve All SAFE" bulk action** — implemented since the last pass
  (`index.js:1390`, `1822-1831`, `3527-3539`). Not re-proposed.
- **Known small polish item (not re-proposed as new):** per
  `research/trlconf_audit_2026-07-10.md`, the new `#trcBtnApproveAllSafe` button is not hidden
  by the early-return branch of `_renderMatchResults()` (`index.js:1713-1719`) when the
  visible event list becomes empty, so it can be left showing a stale label after clearing a
  loaded cut. Low-severity, one-line fix (`approveAllBtn.style.display = 'none'` in that
  branch) — worth folding into whichever of the above ideas next touches that function.
- **Regional/grid-based picture hashing** — `pictureMatcher.js:1-138` already does a 4×4-cell
  dHash with worst-6-cells-discarded robust distance (`N_BEST_CELLS = 10` of 16 cells summed,
  `regionalDistance()`), specifically to survive timecode/logo burn-ins. Not revisited.
- **Confidence label/threshold scheme** — already implemented in two places:
  `_computeRowStatus` (`index.js:1658-1671`) for SAFE/REVIEW/FAIL, and
  `confidenceLabel`/`confidenceColor` in `audioMatcher.js:161-173` for a high/medium/low/none +
  color scheme. Idea #5 above is a messaging refinement, not a new scheme.
- **Compare modes in Verify (side/wipe/overlay/diff)** — already implemented
  (`index.js:1205-1209`, fully wired via `_root?.querySelectorAll('.trc-view-mode-btn')` at
  `3598-3611`). Not revisited.
- **Per-reel slip / "analyze then slip" workflow** — already implemented
  (`_computeReelSlips`/`_applyReelSlips` around `index.js:878-936`) with its own visual
  slip-confidence chip summary (`_renderSlipSummary`, `index.js:1675-1697`). Not revisited.
- **Manual nudge control (±1f/±10f)** — already implemented (`index.js:1236-1239`,
  `3613-3654`, wired to `state.eventCorrections`); the 2026-07-10 refinement idea ("show
  cumulative drift from auto-match, not just delta") is still valid but was not re-ranked
  into the top 8 this pass since ideas #1/#2/#4 above are higher-leverage for the same
  triage workflow.
- **Destructive-action confirmation** — the only `confirm()`/`alert()` in the file is the
  "Reset Match" button's native confirm dialog (`index.js:3487`), used appropriately for an
  irreversible action; not flagged as a problem.
