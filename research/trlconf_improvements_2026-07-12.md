# Trailer Conform — UX Improvement Ideas for Non-Technical Users
_Research date: 2026-07-12 (third pass; follow-up to 2026-07-10 and 2026-07-11)_

## Summary

Trailer Conform is a mature single-panel workflow (`src/scripts/features/trlconf/index.js`,
~3,917 lines) with 5 numbered steps (Inputs → AI Match → Results → Verify → Export), a
region-robust 4×4 dHash picture matcher (`modules/conform/pictureMatcher.js`) that already
discards burn-in-corrupted cells, and filename/duration/audio confidence scoring
(`modules/conform/audioMatcher.js`) feeding a SAFE/REVIEW/FAIL classifier
(`_computeRowStatus`, `index.js:1661-1674`).

**What shipped since the prior passes** (verified in current code, not re-proposed):
- **Approve All SAFE** bulk button — `index.js:1390`, render at `1825-1834`, handler at `3542+`.
- **Pre-export confidence gate** (`_confirmExportWithPendingReviews`, `index.js:2903`) now
  also counts UNMATCH events before letting Export proceed.

**What I re-verified is still NOT built** (so the strongest of these carry forward below):
grepped current `index.js` for a status filter, a legend/tooltip, auto-advance, a coverage
warning, a plain-language error mapper, a summary sentence, and inline failed-file names —
none exist yet. "see console" is still the only failure trace (`index.js:2881`, `3471`,
`3472`, `2740`).

**New this pass** (not on any prior list). Reading the match flow end-to-end surfaced two
things earlier passes missed: (1) the AI MATCH step shows **three** separate technical
buttons (`Build Reference Fingerprints` / `Index Source Frames` / `Auto Match + Slip`,
`index.js:1349-1351`) even though the app **already auto-indexes on source drop and
auto-runs the whole match** when all three inputs are present (`_autoIndexSource` →
`index.js:2896-2898`; also `2814`, `3328`) — so those buttons imply a manual sequence that
isn't actually required; and (2) the SAFE/REVIEW/FAIL thresholds are **hardcoded**
(`index.js:1670-1673`: `c>=82 && variance<=2 && samples>=3`, etc.) with no way for a
coordinator to say "be stricter / be more forgiving" — the task's "smarter defaults for
matching" ask is unaddressed.

## Prioritized Ideas (max 8)

### 1. Collapse the 3 technical match buttons into one "Run Auto-Conform" primary action  ·  **NEW**  ·  Effort: S/M
- **What to change:** The AI MATCH panel head exposes three buttons —
  `#trcBtnBuildFP` "Build Reference Fingerprints", `#trcBtnIndexSource` "Index Source
  Frames", and `#trcBtnRunMatch` "▶ Auto Match + Slip" (`index.js:1349-1351`, gated by
  `_updateMatchBtns`, `index.js:2766-2781`). But loading source already auto-indexes
  (`_autoIndexSource`, called on source drop, `index.js:3390`) and the match auto-runs the
  moment all three inputs exist (`index.js:2814`, `2896-2898`, `3328`). Make **one** primary
  button ("Run Auto-Conform" / "Match Now") the only thing a non-tech user sees, and move
  Build-Fingerprints / Index-Source behind a small "Advanced ▾" disclosure (or drop them —
  they are redundant re-entry points for steps the app performs automatically).
- **Why it helps:** Three verb-y engineering buttons make an editor ask "which do I press,
  and in what order?" when the honest answer is "none — it already ran." One clear action
  (plus an unobtrusive advanced escape hatch for re-indexing) matches how the feature
  actually behaves and removes the single biggest source of button-confusion in the panel.
- **Note:** Keep the auto-run behavior; this is a layout/labeling change, not a logic change.

### 2. Auto-advance to the next REVIEW/FAIL row after each decision  ·  carry 07-11 #4 / 07-10 #5  ·  Effort: M
- **What to change:** After Approve/Reject/Mark-Review — in the Results row `data-act`
  handler (`index.js:~3657+`) and the Verify buttons `#trcBtnApproveMatch` /
  `#trcBtnRejectMatch` / `#trcBtnMarkReview` (wired ~`3542-3578`) — call `_selectRow()`
  (`index.js:1856`) on the next unresolved REVIEW/FAIL row by index order instead of leaving
  `state.selectedEvId` unchanged.
- **Why it helps:** The core triage loop is "look at the frames → decide → next." Today every
  decision forces the user back to the table to hunt for the next flagged row. Auto-advance
  turns triage into a continuous look-decide-look loop — the highest per-click savings for
  the exact users this feature targets. Still unimplemented (no `advance`/`nextUnresolved`
  logic anywhere in current code).

### 3. Add a status filter / worklist toggle above the Results table  ·  carry 07-11 #2  ·  Effort: S/M
- **What to change:** Add a small segmented control in `.trc-panel-head` next to
  `#trcResultsStats` (`index.js:1387-1390`): All / SAFE / REVIEW / FAIL. Filter the
  `visibleEvents` array *inside* `_renderMatchResults` right before the `.map()`
  (`index.js:1729`) — leave `_getVisibleEvents()` itself untouched so export/summary math
  keeps using the full list.
- **Why it helps:** On a 100+ event cut where most rows are SAFE, a coordinator must scroll
  past everything already handled to find the few that need attention. "Show REVIEW + FAIL
  only" turns the table into a worklist and pairs naturally with Approve All SAFE (approve
  the safe ones, then filter down to what's left). Pure render-layer change; no matching
  logic touched.

### 4. Make the words understandable: a summary sentence, a status legend, and de-jargoned copy  ·  merges 07-11 #5+#8, plus NEW copy fixes  ·  Effort: S
- **What to change:** Three small, related copy additions/edits around the Results panel:
  (a) Above the raw stats string ("142 events · 128 SAFE · 11 REVIEW · 3 FAIL",
  `index.js:1818-1822`) add one guidance sentence — "128 of 142 events matched automatically
  and are ready to approve. 14 need your attention before export." (b) Add a one-line legend
  or "?" popover near the table header defining SAFE/REVIEW/FAIL and Visual %/Audio %/Final %
  in plain terms (columns at `index.js:1409-1412`; thresholds at `1670-1673`). (c) **NEW:**
  rewrite the always-visible engineer-facing match note ("Reference QT filename only infers
  episode ID. Visual and audio alignment drive conform. Filename and timecode are weak hints
  only.", `index.js:1357`) and jargon column headers ("Corr. Src In/Out", "Reel slips
  applied") into editor language.
- **Why it helps:** Every number and badge in Results currently ships with zero in-app
  explanation, and the one sentence that *is* there reads like a design doc. Non-tech users
  must guess or ask engineering what "REVIEW, 71% visual" means. Same data, framed as a
  to-do they can act on (and even paste into a producer status update).

### 5. Actionable failure messages: name the files, and translate raw errors  ·  merges 07-11 #3+#7  ·  Effort: M
- **What to change:** (a) Replace "see console" with the actual filenames: source indexing
  catches each decode failure and only `console.warn`s the name, while the UI shows a bare
  count (`index.js:2881`, `3471`, `3472`, and the every-event-failed case at `2740`).
  Collect failed filenames into an array during the loop and render them (e.g. "Couldn't
  read: REEL_204_B.mov, REEL_207_C.mov"). (b) Route the raw `Error: ${err.message}` dumps
  (`index.js:2505`, `2753`, `3418`, `3479`) through a small mapper for known classes
  (companion unreachable / codec unsupported / proxy timeout / seek timeout) into a sentence
  with a next step — extending the light cleanup that already exists for the Reference QT
  path only.
- **Why it helps:** "See console", "ECONNREFUSED", and "companion" are meaningless to an
  editor who has no devtools open. Naming the physical files that failed lets them
  re-export/re-transcode with zero engineering involvement; plain-language guidance turns
  support tickets into self-service.

### 6. Surface source-coverage gaps in the Inputs panel before Auto Match runs  ·  carry 07-11 #6  ·  Effort: S
- **What to change:** `_buildReelMap()` (`index.js:940-976`) already classifies every proxy
  reel as matched/low/unmatched/skip, but the Source ProRes card only ever shows file counts
  (`trcSourceInfoCount`/`Indexed`/`Dur`/`Status`, `index.js:1329-1332`). Once both the cut and
  source are loaded, add one warning line: "3 clips in your cut have no matching source file
  and will be skipped."
- **Why it helps:** Catches an unfixable-at-match-time problem (missing coverage) *before* the
  user waits through a full auto-match pass and then reverse-engineers why some rows came back
  FAIL. The classification already exists — it's just never shown.

### 7. Add a matching-strictness preset (Conservative / Balanced)  ·  **NEW** — the "smarter defaults" ask  ·  Effort: M
- **What to change:** `_computeRowStatus` hardcodes the SAFE/REVIEW/FAIL cutoffs
  (`index.js:1670-1673`: `c>=82 && variance<=2 && samples>=3` → SAFE; `c>=58 && variance<=8
  && samples>=2` → REVIEW; …). Expose 2–3 named presets that shift these as a set —
  "Conservative" (more rows land in REVIEW for a human look), "Balanced" (today's values),
  optionally "Lenient" (more auto-SAFE) — with a one-line plain description of each, stored in
  `state` and read by `_computeRowStatus`.
- **Why it helps:** Directly answers the brief's "smarter defaults for matching." Different
  shows tolerate different risk; today a coordinator who feels there's too much REVIEW (or
  wants a stricter pass on a tentpole trailer) has no lever short of manually re-judging every
  row. A named preset lets a non-engineer tune trust/effort without understanding variance or
  sample counts. Prior passes deliberately avoided touching the threshold scheme — this is the
  first proposal to make it user-controllable rather than just re-worded.

### 8. Opt-in "auto-approve high-confidence (SAFE) matches"  ·  **NEW**  ·  Effort: S/M
- **What to change:** Add a single checkbox setting ("Auto-approve high-confidence matches")
  that, when on, marks SAFE rows approved as they're classified — so the user lands in Results
  with SAFE already handled and only REVIEW/FAIL to triage. Reuse the exact approve path the
  existing Approve All SAFE handler uses (`index.js:3542+`); make it fully undoable via the
  existing per-row Reject/Review actions. Default off (opt-in) to preserve current behavior.
- **Why it helps:** For trailer/promo cuts where 60–90% of events land SAFE, "Approve All
  SAFE" is already a reflexive one-click habit (per the 07-11 log). Making it an opt-in
  default removes even that click for the common case and reinforces the mental model that
  SAFE = trustworthy, letting coordinators spend their attention only on what genuinely needs
  a human. Complements — does not duplicate — the existing bulk button.

## Already shipped / intentionally not re-proposed
- **Approve All SAFE** bulk action (`index.js:1390`, `1825-1834`, `3542+`) — shipped 07-10.
- **Pre-export confidence gate** incl. UNMATCH tally (`_confirmExportWithPendingReviews`,
  `index.js:2903`; wired into `_exportCorrectedXML`) — shipped 07-11.
- **Region-robust picture hashing** — `pictureMatcher.js` already does 4×4-cell dHash with
  worst-6-cells discarded to survive burn-ins/logos; do not re-implement.
- **Verify compare modes** (Side/Wipe/Overlay/Difference, `index.js:1206-1209`) — fully wired.
- **Per-reel slip workflow** (`_computeReelSlips`/`_applyReelSlips`, `index.js:878-936`;
  chips via `_renderSlipSummary`) — exists.
- **Manual ±1f/±10f nudge** (`index.js:1236-1239`) — exists. The 07-10 refinement (show
  cumulative drift from auto-match) is still valid but scored below the 8 above.

## Suggested build order for the coding job
Fastest visible wins first: **#3 (filter)** and **#4 (copy/legend/summary)** are small and
high-visibility; **#1 (single match button)** is the biggest clarity win for a modest change;
**#2 (auto-advance)** and **#5 (errors)** are medium but high-value. **#7 (strictness preset)**
and **#8 (auto-approve)** are the two that change matching behavior — do them last and behind
opt-in defaults so current behavior is preserved.
