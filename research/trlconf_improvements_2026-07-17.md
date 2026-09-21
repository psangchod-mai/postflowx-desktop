# Trailer Conform — UX Improvement Ideas for Non-Technical Users
_Research date: 2026-07-17 (sixth pass; follow-up to 2026-07-10 → 2026-07-16). Read-only research._

## What exists today (grounded in current code)

Trailer Conform is a single-panel, 5-step flow in
`src/scripts/features/trlconf/index.js` (**4,863 lines**): **1 INPUTS → 2 AI MATCH → 3 MATCH
RESULTS → 4 VERIFY → 5 EXPORT** (`_buildHTML`, `index.js:1345`).

- **Matching engine.** Per-event visual solver `_matchEventByVisualWave` (`index.js:867`) samples a
  few timeline offsets per event, hashes each with the region-robust 4×4-cell dHash
  (`modules/conform/pictureMatcher.js` `regionalHash`/`regionalDistance`, worst-6-cells discarded),
  searches the master via `_searchMasterForFrame` (`index.js:566`, coarse → wide/global → fine),
  blends a 2.5 s luma-envelope "audio" term (`0.85·visual + 0.15·audio`, `index.js:3057`), and
  independently refines the OUT point (`_refineSourceOut` + `modules/conform/endRefine.js`). A
  whole-library fallback re-searches weak/FAIL events across other masters
  (`_multiMasterFallback`, `index.js:3099`; `modules/conform/multiMaster.js`).
- **Reel mapping.** `_buildReelMap` (`index.js:1094`) pins each proxy reel to a master **only when
  `bestScore >= 100`** — i.e. exact episode-number equality from `_extractEpNum`/`_epScore`
  (`index.js:145`, `172`). Off-by-one scores 20; anything below 100 becomes `low`/`unmatched`.
- **Status/confidence.** `_computeRowStatus` (`index.js:1862`) buckets rows SAFE/REVIEW/FAIL using
  **hardcoded** cutoffs (`c>=82 & var<=2 & samples>=3` → SAFE; `c>=58 & var<=8 & samples>=2` →
  REVIEW; `index.js:1871`). Wide-search gate is a hardcoded `68` (`index.js:580`, `895`, `919`;
  `WEAK_MATCH_CONFIDENCE` in multiMaster.js).

**Already shipped since the 07-16 list — do NOT re-propose (verified present in current code):**
- Plain-language "why" sentence on REVIEW/FAIL/UNMATCH rows — `_buildMatchReasonSentence`
  (`index.js:1880`), rendered at `index.js:2072`.
- Rough ETA during match — `_formatEtaRemaining` (`index.js:1903`), wired at `index.js:3010-3014`.
- "Last matched N ago" badge — `_relativeTimeAgo` (`index.js:1917`), `#trcSbLastMatched`.
- Manual reel-to-source **Fix dropdown** for unmatched/low reels — `trc-fix-reel-select`
  (`index.js:2140`), plus "Needs a source file: …" naming (`index.js:2147`).
- Verify-panel confidence line — `#trcVerifyConfidenceLine` (`index.js:1383`).
- Results **status filter** (All/SAFE/REVIEW/FAIL, `index.js:1564`), **Approve All SAFE**
  (`index.js:1570`), plain-language progress phases (`index.js:1534-1546`), plain-language Export
  panel + live preview (`index.js:1649-1655`), results summary sentence + legend (`index.js:1572`).
- "N source files not used by this cut" pre-flight note — `index.js:3599-3607`.
- Advanced steps (`Build Reference Fingerprints`, `Index Source Frames`) now collapsed under a
  `<details>Advanced</details>` (`index.js:1520-1526`) — main flow is one **Run Auto-Conform** button.

Everything below is **new** (grepped current code to confirm it does not already exist) and,
except where noted, additive — it does not rewrite the matching engine.

---

## Prioritized Ideas (most impactful first, max 8)

### 1. Tell the user when a SOURCE FILE FAILED TO OPEN (don't hide it in the console) · Effort: S/M
- **What to change:** When a master won't decode, `_runConform` does only
  `console.warn('[TrlConform] Cannot load master', …)` then `doneCount += group.events.length;
  continue;` (`index.js:2991-2995`). Those events get **no** `eventCorrections` entry, so
  `_computeRowStatus` returns `UNMATCH` (`index.js:1866`) and `_buildMatchReasonSentence` prints the
  wrong reason: *"No match was attempted for this event."* (`index.js:1881`). The true cause (ProRes
  couldn't decode / companion proxy unavailable — see the specific errors thrown in `_loadVideo`,
  `index.js:477`, `488`) is invisible. Capture the failed master name(s) into state and (a) surface a
  banner in the Results area ("Couldn't open 2 source files: X, Y — they may be an unsupported codec
  or the media engine is offline") and (b) make those rows' reason read "Source file X couldn't be
  opened" instead of "No match was attempted."
- **Why it helps non-technical users:** A coordinator never sees the console. Today a whole reel can
  silently come back FAIL/UNMATCH with a misleading reason, and they have no idea it was a decode
  problem (fixable by re-exporting the MOV or starting the media engine) versus a genuine no-match.
  This is the single biggest honesty/trust gap left in the tool.

### 2. Add a Strict / Balanced / Lenient matching preset (smarter, adjustable defaults) · Effort: M
- **What to change:** SAFE/REVIEW/FAIL cutoffs are hardcoded in `_computeRowStatus`
  (`index.js:1871-1874`) and mirrored in the solver's own `status` at `index.js:997-1001`; the
  wide-search confidence gate is a hardcoded `68` (`index.js:580/895/919`). There is **no** UI to
  tune sensitivity (grep for "strict/preset/sensitivity/auto-approve" → nothing). Add one small
  segmented control near the Run button — **Balanced** (today's numbers), **Strict** (higher SAFE bar,
  fewer auto-approvable rows), **Lenient** (lower bars, more rows land SAFE) — feeding the cutoffs
  from a single settings object instead of literals. Optionally pair with an "Auto-approve SAFE rows"
  checkbox that runs the existing Approve-All-SAFE path automatically at match end.
- **Why it helps non-technical users:** Different jobs have different tolerance (a rush promo vs. a
  finishing conform). Non-technical users can't edit code to change `82`/`58`; a three-way preset lets
  them pick a risk level in plain terms and, with auto-approve, removes a whole manual pass of
  clicking Approve on rows the app is already confident about.

### 3. Auto-advance to the next unresolved row after each Approve/Reject decision · Effort: M
- **What to change:** `_selectRow` (`index.js:2201`) is only ever called from explicit user clicks
  (`index.js:4428/4436/4457`); after a coordinator approves/rejects/marks-review a row (buttons at
  `index.js:2078-2081` and the Verify panel `index.js:1410-1412`), focus stays put and they must hunt
  for the next thing to look at. After a decision, automatically select the next REVIEW/FAIL/UNMATCH
  row (respecting the active status filter, `state.resultsFilter`) and load it into Verify.
- **Why it helps non-technical users:** Turns triage into a guided queue ("decide → next → decide")
  instead of a scroll-and-search chore across a 100+ row table. This is the natural companion to the
  status filter and Verify panel that already shipped, and it's the standing backlog item from 07-13
  that is still unbuilt.

### 4. One smart "Conform" action that auto-routes EDL vs. no-EDL · Effort: S/M
- **What to change:** Step 2 exposes two sibling buttons the user must choose between — **Run
  Auto-Conform** (`#trcBtnRunMatch`, needs parsed events) and **Detect Shots (no EDL)**
  (`#trcBtnDetectShots`, `index.js:1516-1517`), gated separately by `canRun`/`canDetect`
  (`index.js:3480-3481`). A non-technical user often doesn't know whether their dropped file yielded
  usable events. Make the primary button always "Conform" and internally route: if
  `state.events.length > 0` run `_runConform`; otherwise fall back to the shot-detect path — keeping
  the explicit Detect button only under Advanced for power users.
- **Why it helps non-technical users:** Removes a decision that requires understanding what an EDL is
  and whether the parse succeeded. One obvious button that "does the right thing" is far friendlier
  than two similar-looking buttons with a jargon distinction ("agency EDL/XML").

### 5. Smarter default: when exactly one Source ProRes file is loaded, pin every reel to it · Effort: S
- **What to change:** `_buildReelMap` (`index.js:1094`) independently scores each proxy reel by
  episode number and only pins at `bestScore >= 100` (`index.js:1118`). If a coordinator loads a
  single source file and the reel's filename doesn't carry a clean 3-digit episode
  (`_extractEpNum` returns null → `status:'skip'`, `index.js:1122`), every event is left unmatched
  even though the intended source is unambiguous. Add a short-circuit: if `masterFiles.length === 1`,
  pin all reels to it (still let the visual solver + `_multiMasterFallback` verify).
- **Why it helps non-technical users:** Conforming one episode's trailer beat against one master is a
  common, unambiguous case. Requiring a filename to contain a parseable episode number before the app
  will even try is a surprising failure for a user who can plainly see there's only one choice.

### 6. Keyboard shortcuts for the Verify triage loop · Effort: S/M
- **What to change:** There are no keyboard handlers anywhere in the feature (grep for
  `keydown`/`ArrowRight`/`shortcut` → nothing). The Verify panel already has Approve / Reject / Mark
  Review buttons and ±1f/±10f nudge (`index.js:1403-1412`). Add scoped shortcuts while Verify is
  open: A = approve, R = reject, arrow keys = ±1 frame, Shift+arrow = ±10, and a "next" key that
  drives idea #3.
- **Why it helps non-technical users:** Editors live on the keyboard. Nudging frame-by-frame and
  approving via mouse-hunting for small buttons is slow and error-prone; a few memorable keys make the
  review pass feel like scrubbing in an NLE rather than filling in a web form.

### 7. Show confidence as a plain word next to the %, reusing the already-written (but unused) label helper · Effort: S
- **What to change:** `audioMatcher.js` exports `confidenceLabel` (high/medium/low/none) and
  `confidenceColor` (`audioMatcher.js:161-173`) — confirmed **never imported** into `index.js`. The
  Results table shows only bare numbers in Visual %/Audio %/Final % (`index.js:2067-2069`). Render the
  word beside the Final % (e.g. "78% · Medium") using the existing helper so the meaning of the number
  is self-evident without cross-referencing the legend.
- **Why it helps non-technical users:** "61%" means little on its own; "61% · Low" is instantly
  legible and reinforces the SAFE/REVIEW/FAIL badge. It reuses code that already exists and was
  clearly intended for exactly this, at essentially zero risk.

### 8. A short "how this works" guided empty state on first load · Effort: S
- **What to change:** Before inputs are loaded the Results area shows a single terse hint — "Load XML,
  Reference QT, and Source ProRes to start AI conform. / Reference QT is timeline truth. Source
  timecode may differ." (`#trcEmptyState`, `index.js:1582-1584`). Expand it into a compact 3-step
  visual ("1 Drop your editorial cut · 2 Drop the reference QT · 3 Drop the source ProRes → press
  Conform") that mirrors the numbered panels, shown only until the first input lands.
- **Why it helps non-technical users:** A coordinator opening the tool cold has three drop zones and
  jargon ("Reference QT is timeline truth", "candidate source media") with no narrative of what to do
  first or why. A tiny numbered walkthrough removes the "what am I looking at" moment without adding a
  modal or docs to maintain.

---

## Suggested build order
Cheapest / self-contained first: **#7** (reuse existing label helper), **#8** (empty-state copy),
**#5** (single-source pin — one branch in `_buildReelMap`). Then **#1** (decode-failure surfacing —
touches state + render but no matching logic) and **#4** (button routing). **#2** (preset) and **#3**
(auto-advance) are the larger, higher-value workflow changes; **#6** (shortcuts) pairs naturally with
#3. Only **#5** and **#2** alter matching behavior — validate both against the existing
`_multiMasterFallback` / `_applyReelSlips` paths so a new default or cutoff doesn't fight the reel-slip
collapse.
