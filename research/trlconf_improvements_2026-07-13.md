# Trailer Conform — UX Improvement Ideas for Non-Technical Users
_Research date: 2026-07-13 (fourth pass; follow-up to 2026-07-10, 2026-07-11, 2026-07-12)_

## Summary

Trailer Conform remains a single-panel, 5-step workflow (`src/scripts/features/trlconf/index.js`,
~3,948 lines): Inputs → AI Match → Results → Verify → Export. Matching is auto-driven — dropping
the Source ProRes auto-indexes (`_autoIndexSource`, `index.js:2859`) and the full visual+audio
match auto-runs the moment all three inputs exist (`index.js:2844-2846`, `2927-2929`). Picture
matching is the region-robust 4×4 dHash (`modules/conform/pictureMatcher.js`, worst-6-cells
discarded); confidence scoring lives in `modules/conform/audioMatcher.js` and the SAFE/REVIEW/FAIL
classifier is `_computeRowStatus` (`index.js:1670-1683`, hardcoded cutoffs `c>=82 && variance<=2
&& samples>=3` etc.).

**What shipped in the last three passes** (verified in current code, NOT re-proposed as new):
- **Approve All SAFE** bulk button — `index.js:1390`, render `1856-1865`, handler `3573-3585` (07-10).
- **Pre-export confidence gate** incl. UNMATCH tally — `_confirmExportWithPendingReviews`,
  `index.js:2934-2943`, wired into `_exportCorrectedXML` at `2947` (07-11).
- **Plain-language summary sentence + status legend + de-jargoned AI MATCH note** —
  `#trcResultsGuide`/`#trcResultsSummary`/`.trc-results-legend` at `index.js:1392-1400`, summary
  logic `1837-1854`, match note rewritten `1356-1358` (07-12).

**Re-verified still NOT built** (grepped current `index.js`): no status filter/worklist toggle,
no auto-advance / next-unresolved logic, no source-coverage warning, no plain-language error
mapper, no strictness preset, no auto-approve setting, no keyboard shortcuts, and no collection of
failed source filenames. "See console" is still the only failure trace (`index.js:2771`, `2912`,
`3502`, `3503`), and raw `Error: ${err.message}` dumps still surface at `2536`, `2784`, `3449`,
`3510`. The three technical match buttons still stand at `index.js:1349-1351`.

**New this pass** (not on any prior list): reading the auto-run flow end-to-end surfaced that the
**seven progress-phase labels** an editor stares at during every auto-match are pure engineer
phrasing ("Sampling reference frames", "Reading reference audio", "Indexing source frames",
"Solving offsets" — `index.js:1361-1373`); and the **five Export checkboxes** (`index.js:1468-1472`)
are jargon with non-obvious interactions (`onlyApproved` vs `includeApprovedReview` resolved deep
in `_shouldApplyCorrection`, `1558-1573`) with no plain "here's what will export" confirmation. Both
are concrete, additive copy/clarity wins the prior passes missed.

## Prioritized Ideas (max 8)

### 1. Collapse the 3 technical match buttons into one "Run Auto-Conform" action  ·  carry 07-12 #1  ·  Effort: S/M
- **What to change:** The AI MATCH head still shows three verb-y buttons — `#trcBtnBuildFP`
  "Build Reference Fingerprints", `#trcBtnIndexSource` "Index Source Frames", `#trcBtnRunMatch`
  "▶ Auto Match + Slip" (`index.js:1349-1351`, enabled/disabled by `_updateMatchBtns`,
  `2797-2812`). But indexing already fires on source drop (`_autoIndexSource`) and the match
  auto-runs when all three inputs are present (`2844-2846`, `2927-2929`). Show a **single** primary
  button ("Run Auto-Conform" / "Match Now") and move Build-Fingerprints / Index-Source behind a
  small "Advanced ▾" disclosure (or drop them — they re-trigger steps the app already does).
- **Why it helps non-technical users:** Three engineering buttons make an editor ask "which do I
  press, in what order?" when the honest answer is "none — it already ran." One clear action plus a
  tucked-away escape hatch matches the real behavior and removes the single biggest button-confusion
  in the panel. Layout/label change only — keep the auto-run logic.
- **Carried over** from 07-12 (never implemented); still the highest-clarity change for the effort.

### 2. Rewrite the 7 progress-phase labels into plain language  ·  **NEW**  ·  Effort: S
- **What to change:** During every auto-match the user watches the phase strip
  (`#trcPhStep0..6`, `index.js:1361-1373`): "Parsing XML", "Sampling reference frames", "Reading
  reference audio", "Indexing source frames", "Indexing source audio", "Solving offsets", "Done".
  Rewrite these to describe outcomes, e.g. "Reading your cut", "Looking at the reference picture",
  "Listening to the reference sound", "Scanning source picture", "Scanning source sound", "Lining
  everything up", "Finished". Pure `textContent` of static spans — no logic touched.
- **Why it helps non-technical users:** This is the one place the app narrates itself while an
  editor waits, and it currently reads like a debug trace. "Sampling reference frames" / "Solving
  offsets" mean nothing to a coordinator; plain outcome-language builds trust that the tool is doing
  the obvious thing, and is the lowest-risk, highest-visibility copy win left. Complements the
  07-12 de-jargoning of the AI MATCH note, which stopped at the note and never touched these labels.

### 3. Add a status filter / worklist toggle above the Results table  ·  carry 07-11 #2 / 07-12 #3  ·  Effort: S/M
- **What to change:** Add a small segmented control in `.trc-panel-head` next to `#trcResultsStats`
  (`index.js:1386-1391`): All / SAFE / REVIEW / FAIL. Filter the `visibleEvents` array *inside*
  `_renderMatchResults` right before the `.map()` at `index.js:1741` — leave `_getVisibleEvents()`
  untouched so export/summary math (`_getExportSummaryData`, `1575`) still uses the full list.
- **Why it helps non-technical users:** On a 100+ event cut where most rows are SAFE, a coordinator
  must scroll past everything already handled to find the few that need attention. "Show REVIEW +
  FAIL only" turns the table into a worklist and pairs naturally with Approve All SAFE (approve the
  safe ones, then filter to what's left). Pure render-layer change; no matching logic touched.
- **Carried over** from 07-11/07-12; still unbuilt (confirmed no filter/sort/search anywhere).

### 4. Auto-select the first row needing attention, and auto-advance after each decision  ·  NEW auto-select + carry 07-10 #5 / 07-11 #4 / 07-12 #2  ·  Effort: M
- **What to change:** Two linked changes. (a) **NEW:** when a match completes, nothing is selected —
  `state.selectedEvId` stays null and the user hunts for a row to click. After the results render
  (`index.js:2776`), auto-call `_selectRow()` (`1887`) on the first REVIEW/FAIL/UNMATCH row so the
  user lands directly in the triage loop with frames already loaded. (b) After Approve/Reject/
  Mark-Review — in the Results delegated handler (`index.js:3702-3746`) and the Verify buttons
  (`3588-3622`) — advance `_selectRow()` to the next unresolved REVIEW/FAIL row by index order
  instead of leaving the selection unchanged.
- **Why it helps non-technical users:** The core loop is "look at frames → decide → next." Today
  every decision dumps the user back to the table to re-find the next flagged row, and after a match
  they must manually locate the first one. Auto-select + auto-advance turns triage into a continuous
  look-decide-look flow — the highest per-click savings for exactly these users. Still no
  advance/next-unresolved logic anywhere in current code.

### 5. Actionable failures: name the files, and translate raw errors  ·  carry 07-11 #3+#7 / 07-12 #5  ·  Effort: M
- **What to change:** (a) Replace "see console" with the actual filenames: `_autoIndexSource` and
  the manual index path each `console.warn` the failed filename but the UI shows only a bare count
  (`index.js:2900` + `2912`; `3493` + `3502`/`3503`). Collect failed names into an array during the
  loop and render them (e.g. "Couldn't read: REEL_204_B.mov, REEL_207_C.mov"). Also fix the
  all-events-failed completion message (`2771`) which dumps `lastEvErr.message` + "see console for
  details". (b) Route the raw `Error: ${err.message}` strings (`2536`, `2784`, `3449`, `3510`)
  through a small mapper for known classes (companion unreachable / codec unsupported / proxy or
  seek timeout) into a sentence with a next step — extending the light cleanup that today exists
  only for the Reference QT decode path.
- **Why it helps non-technical users:** "See console", "ECONNREFUSED", and "companion" are
  meaningless to an editor with no devtools open. Naming the physical files that failed lets them
  re-export/re-transcode with zero engineering involvement; plain-language guidance turns support
  tickets into self-service.
- **Carried over** from 07-11/07-12; still the biggest self-service gap.

### 6. Pre-flight warning in Inputs: source-coverage gaps AND episode mismatch  ·  carry coverage + **NEW** episode-mismatch angle  ·  Effort: S
- **What to change:** `_buildReelMap()` (`index.js:940-975`) already classifies every proxy reel as
  `matched`/`low`/`unmatched`/`skip`, but the Source ProRes card only shows file counts
  (`trcSourceInfoCount`/`Indexed`/`Dur`/`Status`, `1329-1332`). Once both cut and source are loaded,
  add one warning line built from the reel map: "3 clips in your cut have no matching source file
  and will be skipped." **NEW angle:** also compare the Reference QT episode (`state.epId`, from
  `_extractEpNum`, `141-165`) against the source files' episodes — if they disagree (all reel-map
  entries `low`/`unmatched`), warn "Your Reference QT looks like episode 204 but your source files
  are episode 203" — the single most common setup mistake, catchable before any match runs.
- **Why it helps non-technical users:** Catches unfixable-at-match-time problems (missing coverage,
  wrong reference/source pairing) *before* the user waits through a full auto-match and then
  reverse-engineers why rows came back FAIL. The classification already exists — it's just never
  surfaced.

### 7. Plain-language Export panel: clarify the 5 checkboxes + a one-line "what will export" preview  ·  **NEW**  ·  Effort: S
- **What to change:** The Export options are five jargon checkboxes with non-obvious interactions —
  "Export only approved matches", "Include approved REVIEW matches", "Leave failed events
  unchanged", "Use relative media paths", "Add review/fail notes if supported" (`index.js:1468-1472`),
  resolved deep inside `_shouldApplyCorrection` (`1558-1573`). Rewrite each label in editor language
  and add one live preview sentence above the Export button, computed from the already-available
  `_getExportSummaryData()` (`1575-1605`): e.g. "Exporting 128 corrected events; 14 left unchanged
  (3 failed, 11 still need review)." Pure copy + one derived sentence — no export logic changed.
- **Why it helps non-technical users:** The final step is where an editor commits the conform, and
  today it's five interacting toggles with no explanation of their combined effect. A plain preview
  ("here's exactly what this button will do") converts an anxious guess into a confident click and
  prevents accidental partial exports. The summary cards already compute the numbers — this just
  states them as a sentence at the point of action. Prior passes touched the Results copy but never
  the Export panel's wording.

### 8. Smarter matching defaults: a strictness preset OR opt-in auto-approve SAFE  ·  carry 07-12 #7/#8 — the "smarter defaults" ask  ·  Effort: M
- **What to change:** Pick one (both were proposed 07-12, neither built): (a) **Strictness preset** —
  `_computeRowStatus` hardcodes SAFE/REVIEW/FAIL cutoffs (`index.js:1679-1682`). Expose 2–3 named
  presets — "Conservative" (more rows land in REVIEW for a human look), "Balanced" (today's values),
  "Lenient" (more auto-SAFE) — each with a one-line plain description, stored in `state` and read by
  `_computeRowStatus`. (b) **Opt-in auto-approve** — a single "Auto-approve high-confidence matches"
  checkbox that approves SAFE rows as they're classified, reusing the exact path the Approve All SAFE
  handler uses (`3573-3585`), fully undoable via per-row Reject/Review, default off.
- **Why it helps non-technical users:** Directly answers the brief's "smarter defaults for matching."
  Different shows tolerate different risk; today a coordinator who feels there's too much REVIEW (or
  wants a stricter tentpole pass) has no lever short of re-judging every row. A named preset lets a
  non-engineer tune trust/effort without understanding variance or sample counts; auto-approve
  removes even the reflexive Approve-All-SAFE click for the common 60–90%-SAFE case. Do this last,
  behind opt-in defaults, so current behavior is preserved.

## Already shipped / intentionally not re-proposed
- **Approve All SAFE** bulk action (`index.js:1390`, `1856-1865`, `3573-3585`) — shipped 07-10.
- **Pre-export confidence gate** incl. UNMATCH tally (`_confirmExportWithPendingReviews`,
  `index.js:2934-2943`) — shipped 07-11.
- **Results summary sentence + status legend + de-jargoned AI MATCH note** (`index.js:1392-1400`,
  `1837-1854`, `1356-1358`) — shipped 07-12. (Known Low nit from the 07-12 audit: the summary
  sentence omits MANUAL-status rows — worth folding into whichever pass next touches
  `_renderMatchResults`, but not re-listed as a headline idea.)
- **Region-robust picture hashing** — `pictureMatcher.js` 4×4-cell dHash, worst-6-cells discarded.
  Do not re-implement.
- **Verify compare modes** (Side/Wipe/Overlay/Difference, `index.js:1206-1209`) — fully wired.
- **Per-reel slip workflow** (`_computeReelSlips`/`_applyReelSlips`, `index.js:878-936`; chips via
  `_renderSlipSummary`, `1687-1709`) — exists.
- **Manual ±1f/±10f nudge** (`index.js:1236-1239`, handler `3660-3700`) — exists. The 07-10
  refinement (show cumulative drift from auto-match) is still valid but scored below the 8 above.

## Suggested build order for the coding job
Fastest visible wins first: **#2 (phase labels)** and **#7 (export copy/preview)** are pure-additive
copy, effort S, high visibility. **#3 (filter)** and **#1 (single match button)** are the biggest
clarity-for-effort structural wins. **#4 (auto-select + advance)** and **#5 (errors)** are medium but
high-value for triage and self-service. **#6 (pre-flight warning)** is small and prevents wasted
runs. **#8 (smarter defaults)** changes matching behavior — do it last, behind opt-in defaults, so
current behavior is preserved.
