# Trailer Conform — UX Improvement Ideas for Non-Technical Users
_Research date: 2026-07-16 (fifth pass; follow-up to 2026-07-10 through 2026-07-13; audited 2026-07-14)_

## Summary

Trailer Conform is still the same single-panel, 5-step workflow
(`src/scripts/features/trlconf/index.js`, ~3,969 lines): Inputs → AI Match → Results → Verify →
Export. Picture matching is the region-robust 4×4 dHash (`modules/conform/pictureMatcher.js`,
worst-6-cells discarded, `regionalHash`/`regionalDistance`); `modules/conform/audioMatcher.js`
supplies filename/duration/luma-envelope scoring helpers used before the heavier per-event visual
wave solver in `index.js` (`_matchEventByVisualWave`, `index.js:727-872`) runs; SAFE/REVIEW/FAIL
comes from `_computeRowStatus` (`index.js:1671-1683`, hardcoded cutoffs).

**What shipped since the last list (verified in current code, not re-proposed):**
- **Plain-language progress-phase labels** — `#trcPhStep0..6` now read "Reading your cut", "Looking
  at the reference picture", "Listening to the reference sound", "Scanning source picture/sound",
  "Lining everything up", "Finished" (`index.js:1361-1373`) — shipped 07-13, confirmed still in place.
- **Plain-language Export panel + live preview** — the 5 export checkboxes are now editor-language
  (`trcOptOnlyApproved` etc., `index.js:1468-1472`) and `#trcExportPreview` renders a derived "Export
  will update N event(s)…" sentence from `_getExportSummaryData()` — shipped 07-14 (only item built
  that pass; verified present and wired into `_renderExportSummary`).

**Re-verified still NOT built** (grepped current `index.js`, no 07-15 research/coding log exists —
this pass picks up straight from 07-13's open backlog): still three technical buttons
(`trcBtnBuildFP`/`trcBtnIndexSource`/`trcBtnRunMatch`, `index.js:1349-1351`); still no status
filter/worklist toggle above the Results table; still no auto-select-first-unresolved-row or
auto-advance-after-decision logic (`_selectRow` is only ever called from explicit user clicks,
`index.js:3725/3733/3754`); still "see console" for indexing/decode failures with no filename list
surfaced (`index.js:2787, 2928, 3519`); still no pre-flight coverage/episode-mismatch warning; still
no strictness preset or auto-approve toggle. None of these are re-listed below as headline items —
they remain the standing backlog from 07-13's file, unchanged.

**New this pass:** reading the confidence-scoring internals (`_matchEventByVisualWave`,
`index.js:814-872`) and the reel-mapping code (`_buildReelMap`, `index.js:940-975`) end-to-end
surfaced concrete data the app already computes but never shows the user: per-sample match
diagnostics (`sampleMatches`, `offsetVarianceFrames`, `consistentSamples`) that could answer "why is
this REVIEW/FAIL" with zero new computation; a reel map that silently drops any proxy scoring below
`bestScore >= 100` into `unmatched`/`low` with no manual "point this reel at that file" escape hatch;
no wait-time signal during the (potentially multi-minute) auto-match; and a Verify panel that opens
to a single frame pair with no indication of *how far off* the two are the moment you land on it.
These are additive, don't touch matching logic, and are not on any prior list.

## Prioritized Ideas (max 8)

### 1. Manual reel-to-source override for unmatched/low-confidence proxies · **NEW** · Effort: M
- **What to change:** `_buildReelMap()` (`index.js:940-975`) only accepts an episode match when
  `bestScore >= 100` (exact episode-number equality); anything else becomes `status: 'low'` or
  `'unmatched'` and every event on that reel is left un-conformable — there is currently no UI
  affordance anywhere in `_buildHTML()` to manually pick a source file for a reel that failed
  auto-detection (grepped: no `<select>`/dropdown tied to `reelMap` in the whole file). Add a small
  "Fix" control next to each `low`/`unmatched` reel (in the Source card's info block or a compact
  reel-map strip above Results) — a dropdown of the loaded source files — that sets
  `entry.masterFile`/`masterName` directly and re-triggers matching for just that reel's events.
- **Why it helps non-technical users:** Episode-number extraction from filenames
  (`_extractEpNum`, `index.js:141-165`) is a best guess; the moment a source file is renamed
  slightly differently than expected (a very common real-world occurrence — e.g. "204_v2" vs
  "TNG2_204"), every event on that reel currently just sits as unmatched with no way to fix it
  short of renaming the actual file and reloading everything. A dropdown override is the single
  biggest "unblock without an engineer" gap in the whole tool.

### 2. Surface a plain-language "why" for REVIEW/FAIL rows using data the app already computed · **NEW** · Effort: S/M
- **What to change:** `_matchEventByVisualWave` already computes and returns `sampleMatches`,
  `consistentSamples`, `offsetVarianceFrames`, and `speedPercent` per event (`index.js:853-871`), but
  none of it reaches the UI beyond the Visual/Audio/Final % columns. Add a small "Why?" link/icon on
  REVIEW and FAIL rows in the Results table (`index.js:1404-1427`) that expands one plain sentence
  built from existing fields, e.g. "The 4 frames we checked didn't agree — matches landed up to 6
  frames apart" (from `offsetVarianceFrames`) or "Only 1 of 4 sample points found a confident match"
  (from `consistentSamples`/`samplesUsed`). No new scoring, no new computation — just reading fields
  that already exist on `state.eventCorrections[ev.id]`.
- **Why it helps non-technical users:** Today a coordinator sees "REVIEW · 61%" and has no way to
  know whether that's a borderline-but-fine match or a genuinely shaky one without opening Verify and
  eyeballing frames themselves. A one-line reason (still visible without leaving the table) helps them
  triage which REVIEW rows to check first and builds trust that a number isn't arbitrary.

### 3. Show a rough time estimate / "this may take a few minutes" during auto-match · **NEW** · Effort: S
- **What to change:** The progress strip (`#trcProgressWrap`, `index.js:1359-1380`) shows a phase
  label, a percent, and `#trcProgressCurrent` (currently used for file-by-file status text like
  "12 source files indexed"), but nothing about expected duration — confirmed no ETA/elapsed-time
  logic anywhere in the file. Track a start timestamp when the match begins and, once a few events
  have completed, compute average ms/event to render "About 2 minutes remaining" (rounded to the
  nearest 30s/minute so it reads as an estimate, not a promise) in `#trcProgressCurrent` or a new
  span next to the percent.
- **Why it helps non-technical users:** Visual+audio matching across dozens of events with wide-search
  fallback (`_searchMasterForFrame`, `index.js:562-637`) can run for minutes with only a slowly-ticking
  percent bar. Editors who don't know the tool's internals have no way to judge "is this frozen or
  just slow" and often re-click Run or restart the app — a rough ETA turns an anxious wait into an
  informed one, and it's derivable from data the loop already has (elapsed time / events done).

### 4. On the Verify panel, immediately show a "how confident" summary line before any manual nudging · **NEW** · Effort: S
- **What to change:** Selecting a row opens the Verify panel straight to two side-by-side frames and
  a waveform strip (`#trcFramesRow`/`#trcWaveOffset`, `index.js:1217-1234`) with no restatement of
  *why* this row needs a look. Add one line above the frame panels — e.g. "REVIEW · 61% confidence ·
  frames differ by up to 6f across samples" — reusing the same fields proposed in #2, so a coordinator
  who jumps straight to Verify (skipping the table) still gets the context instead of two silent
  frames they have to judge cold.
- **Why it helps non-technical users:** Verify is the "look closely and decide" step, but right now it
  gives zero framing for what to look for — the user must remember the row's % from the table (if they
  even looked at it) before judging two frames that may look nearly identical to an untrained eye.
  Stating the specific weakness (variance vs. low confidence vs. few samples) tells them exactly what
  to check the frames/waveform for. Effort S because it reuses #2's sentence-builder and only adds one
  `<div>` + `textContent` set inside the existing `_loadVerifyFrames`/row-select flow.

### 5. Warn before re-running match on a project that already has approved rows · **NEW** · Effort: S
- **What to change:** Grepped for a confirm/guard on `#trcBtnRunMatch`/`trcBtnResetMatch`
  (`index.js:3533, 3449, 3472`) — none exists; re-running match or hitting Reset Match after a
  coordinator has already approved some rows silently re-solves and can overwrite
  `state.matchResults[evId].approved`/`.status` with no confirmation. Add a one-line `confirm()`-style
  guard (matching the existing `_confirmExportWithPendingReviews` pattern at `index.js:2934-2943`) that
  fires only when `Object.values(state.matchResults).some(r => r.approved)` is true: "You've already
  approved N matches — re-running will re-check everything, including approved rows. Continue?"
- **Why it helps non-technical users:** A coordinator triaging a long cut across multiple sessions (or
  who accidentally drops a new source file mid-review, re-triggering `_autoIndexSource` and the
  auto-run at `index.js:2844-2846`) can silently lose an hour of approval decisions with no warning.
  This is a data-loss guard, not a workflow change — it protects work already done, which matters more
  to a non-technical user than to someone comfortable re-deriving state.

### 6. Name the actual source files that ended up unmatched, right in the Results empty/summary area · **NEW**, narrower than the carried-over "actionable failures" item · Effort: S
- **What to change:** `_buildReelMap()` already classifies every reel (`matched`/`low`/`unmatched`/
  `skip`, `index.js:968-971`) but nothing in `_renderMatchResults` or the summary sentence
  (`index.js:1837-1854`) lists *which* proxy clip names ended up in `unmatched`/`low` — a coordinator
  only sees an aggregate FAIL count in the table, one row at a time. Add a short line under
  `#trcResultsSummary`: "No source found for: REEL_204_INT_B, REEL_207_EXT_C" built directly from
  `state.reelMap.filter(r => r.status === 'unmatched' || r.status === 'low').map(r => r.proxyName)`.
- **Why it helps non-technical users:** This is distinct from the carried-over "translate raw
  console errors" item (07-11/07-12/07-13 #5) — that's about *decode/index failures*; this is about
  *coverage gaps* the app already detects cleanly (no source file for an episode) but currently
  requires scrolling the full results table row-by-row to notice. Naming the reels up front tells a
  coordinator exactly which physical files to go find, before they scroll 100+ rows.

### 7. Persist and show "last matched" timestamp per project so re-opening the app doesn't look stale · **NEW** · Effort: S
- **What to change:** The IndexedDB persistence layer (`_idbSaveHandles`/`_idbGetHandles`,
  `index.js:1083-1093`, restore path `~3938`) already restores file handles, XML text, `epId`,
  `fileTcOffsets`, and reel map across app restarts — but there's no stored/shown timestamp of when
  the match was last run, so a coordinator reopening the app after a break has no way to tell "is this
  the result from this morning or last week" before deciding whether to trust it or re-run. Store
  `Date.now()` alongside the persisted state when a match completes and render it as a small "Last
  matched: 2 hours ago" badge near `#trcSbMatch` (`index.js:1192`).
- **Why it helps non-technical users:** Coordinators frequently work across sessions on the same
  cut (revisions land, more source arrives). Without a visible timestamp, the safest assumption for a
  non-technical user is "re-run everything just in case," which wastes minutes to hours on large cuts.
  A visible age indicator lets them decide confidently.

### 8. Warn (don't just skip) when a dropped Source ProRes file has zero matching cut events · **NEW** · Effort: S
- **What to change:** `_buildReelMap()` builds its map from unique proxy reels found in the cut and
  looks up masters by episode number — but there's no reverse check: if a coordinator drops 12 source
  files and only 8 have any corresponding cut event, the other 4 are just silently unused with no
  feedback. Add one line to the Source card status area (`#trcSourceInfoStatus`,
  `index.js:1332`) once both cut and source are loaded: "4 source files aren't used by this cut (may be
  the wrong project or already conformed)."
- **Why it helps non-technical users:** This is the mirror image of the standing 07-13 #6 idea
  (missing coverage for cut events) — it catches the opposite mistake: loading the wrong show's
  source folder, or a folder with extra episodes not in this trailer. Both mistakes look identical
  from the Results table (some rows just work, nothing looks obviously wrong), so this is a cheap
  pre-flight sanity check that complements rather than duplicates the carried-over item.

## Already shipped / intentionally not re-proposed
- **Plain-language progress-phase labels** (`index.js:1361-1373`) — shipped 07-13.
- **Plain-language Export panel + live "what will export" preview** (`index.js:1468-1472`,
  `#trcExportPreview`) — shipped 07-14.
- **Approve All SAFE** bulk action (`index.js:1390`) — shipped 07-10.
- **Pre-export confidence gate** (`_confirmExportWithPendingReviews`, `index.js:2934-2943`) — 07-11.
- **Results summary sentence + status legend + de-jargoned AI MATCH note** (`index.js:1392-1400`) —
  07-12. Legend already explains Visual/Audio/Final % in one line (`index.js:1398`) — do not
  re-propose a generic "explain the confidence score" item; #2/#4 above are more specific (per-row
  *reason*, not a repeat of the % definitions).
- **Region-robust picture hashing** (`pictureMatcher.js`, 4×4-cell dHash) — do not re-implement.
- **Per-reel slip workflow** (`_computeReelSlips`/`_applyReelSlips`, `index.js:878-936`) — exists.
- **Manual ±1f/±10f nudge**, Verify compare modes (Side/Wipe/Overlay/Diff) — exist.
- **Standing open backlog from 07-13** (single match button, status filter/worklist, auto-select +
  auto-advance, actionable console-error translation, source-coverage/episode-mismatch pre-flight
  warning, strictness preset / auto-approve) — still unbuilt as of this pass (re-verified by grep;
  no 07-15 research or coding log exists), but already fully specified in
  `research/trlconf_improvements_2026-07-13.md` — not repeated here to avoid duplication. A future
  coding pass should keep pulling from that file's remaining items *and* this one.

## Suggested build order for the coding job
Cheapest, most self-contained: **#3 (ETA)**, **#7 (last-matched timestamp)**, **#6 and #8 (name
unmatched reels / unused source files)** are pure-additive, read-only-of-existing-state, effort S.
**#2 (why REVIEW/FAIL)** unlocks **#4 (Verify context line)** — build them together since #4 reuses
#2's sentence builder. **#5 (re-run guard)** is a small safety net, do early since it's cheap
insurance against data loss. **#1 (manual reel override)** is the only item here that touches
matching/reel-map state — do it last and test it against the existing per-reel slip workflow so a
manual override doesn't fight `_applyReelSlips`.
