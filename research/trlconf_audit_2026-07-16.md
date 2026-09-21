# Trailer Conform — Security & Correctness Audit
_2026-07-16 · READ-ONLY audit_

## Summary

**Repo state.** Branch `feature/session-ui-and-playback-fixes`. The working tree is very broadly
dirty (`git status --porcelain` → **692 entries**), so the tree cannot be trusted as a proxy for
"today's work." However, today's changes **were cleanly isolable**: only two source files have an
mtime of 2026-07-16 (`find src -newermt 2026-07-16 ! -newermt 2026-07-17`):

- `src/scripts/features/trlconf/index.js`
- `src/styles/main.css`

Cross-checked against `git diff --stat`: `index.js` +869/−…, `main.css` +588/−… . Every function and
element id the coding log claims to have added is present in the live source (`_buildMatchReasonSentence`,
`_formatEtaRemaining`, `_relativeTimeAgo`, `_confirmRerunWithApprovedRows`, `_rematchReelEvents`,
`_idbSaveLastMatchedAt`, `state.lastMatchedAt`, `state.resultsFilter`, the `trc-fix-reel-select`
override UI, `manualOverride` persistence, and the four new template ids). **The log matches
reality** — no claimed change is missing, and no un-logged behavioral change to the trlconf source
was found.

The rest of the audit scope (`src/scripts/modules/conform/`) was **not touched today** — `git diff
--numstat` reports `0 0` for `audioMatcher.js`, `edlParser.js`, `timelineFormats.js`, and `pictureMatcher.js`
has no mtime in today's window. Note: `edlParser.js` and `audioMatcher.js` are **not imported by any
app source** (only by `tests-js/`), so within the live trlconf feature the only active conform module
is `pictureMatcher.js` (imported by `index.js:6`) and `timelineFormats.js` (imported by `ui.js:27`).

**Actual verification results (run by the auditor, not trusting the log):**

- `npm run test:js` → **PASS, exit 0.** All 76 `tests-js/*.test.mjs` suites pass; every summary line
  reads `N passed, 0 failed` (spot: `pictureMatcher` 6/0, `visualMatch` 11/0, `conformWiring` 14/0,
  `timecode` 43/0, `timecodeFuzz` 23/0). No failing test. (The log's "22 passed" figure is just the
  last suite's count — the runner executes many files.)
- `npm run build:renderer` → **PASS, exit 0.** `✓ desktop → dist/desktop/ (361 files, v2026.6.1,
  2026-07-16 12:20 UTC)`. Only warning is the pre-existing `GOOGLE_DESKTOP_CLIENT_ID not set` notice
  (unrelated to trlconf).
- `node tools/scan-innerhtml.mjs --gate` → **PASS, exit 0.** `✓ XSS gate clean`.

No `npm install` was needed; `node_modules` was already present.

## Findings

### Security — NONE

No security issues were found in scope. Concretely verified:
- **No `eval` / `new Function`** anywhere in `trlconf/index.js` or `modules/conform/`.
- **No `child_process` / `exec` / `execSync` / `spawn` / shell-out** in scope. Exported files
  (`_exportCorrectedXML`, `_exportEDL`, `_exportCSVPullList`, `_exportMatchReportJSON`) are written
  via a browser Blob + `<a download>` (`index.js:67-72`), never a shell command. `matchedSourcePath`
  is derived from `file._nativePath`/`webkitRelativePath`/`name` and only ever stored in state or
  written into export text — it is never concatenated into a command or an unsanitized `fs` path.
- **No path traversal** reachable from JSON/user-derived data into an `fs` call within the renderer
  feature; file access is via the File System Access API (handles), not string paths.
- **XSS:** all `innerHTML` interpolation of dynamic data routes through `_esc()` (`index.js:31-35`).
  Verified at the results-table row (`index.js:1901-1919`), the reason line
  (`_esc(_buildMatchReasonSentence(corr))`, `index.js:1917`), and the new manual-override strip
  (`index.js:1980-1992`: `_esc(f.name)`, `_esc(_stem(...))`, `_esc(r.proxyName)`, `_esc(reason)`).
  The independent XSS gate passes. The one unescaped interpolation, `audioPct` at `index.js:1913`,
  is a number-derived string (`` `${corr.audioConfidence}%` `` or `'—'`), not attacker-controllable.
- **Electron/IPC exposure** is out of the changed surface; no preload/IPC change today.

### Correctness

#### MEDIUM — Manual reel override is silently discarded by any reel-map rebuild
**File:** `src/scripts/features/trlconf/index.js` — override written at `4143-4149`; rebuilt away at
`2681` (`_runVisualMatch`), `3173` (`_autoParseXML`), `3253` (`_autoIndexSource`).

The new Fix dropdown (`#trcResultsUnmatchedReels` change handler, `index.js:4127-4154`) fixes an
unmatched reel by mutating the `state.reelMap` entry in place (`entry.masterFile`, `masterName`,
`score=100`, `status='matched'`, `manualOverride=true`) and then re-matching that reel's events.
But `state.reelMap` is **unconditionally rebuilt from scratch** by `_buildReelMap(state.events,
state.masterFiles)` on three later code paths — most importantly `_runVisualMatch` (`index.js:2681`),
i.e. the primary **"Run Auto-Conform"** button. `_buildReelMap` (`index.js:940-975`) classifies a
reel `matched` only when `bestScore >= 100`; a reel that only matched because of the manual override
scores 0 and reverts to `unmatched`, with `masterFile` reset to `null` and `manualOverride` gone.

**Failure scenario:** A coordinator opens a project with one unmatched reel, uses the new Fix
dropdown to point it at the correct source (the whole reason the feature was built), then clicks
"Run Auto-Conform" to finish the job. `_runVisualMatch` rebuilds the reel map → the manually-fixed
reel is `unmatched` again and is excluded from the match loop (which only processes `status==='matched'`
entries), and because the fixed rows were never *approved*, `hasApprovals` is false at `index.js:2684`
so `state.eventCorrections` and `state.matchResults` are wiped too. Net result: the manual fix is
silently and completely lost, with no warning. The new re-run guard `_confirmRerunWithApprovedRows()`
(`index.js:3286-3293`) does **not** catch this, because a manual override produces no *approved* rows.

**Why it matters:** This is the core promised behavior of today's headline feature (let a
non-engineer fix a reel without an engineer). A user's deliberate correction disappears on the most
natural next click. The `manualOverride` flag is persisted to the project file (`exportState`,
`index.js:4324`) but that does not help within a live session before the reel map is rebuilt.

#### LOW — "Last matched" timestamp is stamped even when the run was cancelled
**File:** `src/scripts/features/trlconf/index.js:2942-2943`

At the end of `_runVisualMatch`, `state.lastMatchedAt = Date.now()` and `_idbSaveLastMatchedAt(...)`
run unconditionally, after the loop that can `break` early on `state.visualMatchCancel`
(`index.js:2825`, `2843`). So pressing Stop mid-match still records a fresh "Last matched: just now"
badge (`index.js:1688-1689`) and persists it, implying a completed conform that did not happen.
Cosmetic/trust issue only — no data corruption. (Contrast `progCur` at `index.js:2957`, which
correctly branches on `visualMatchCancel`.)

#### LOW — `_rematchReelEvents` ignores cancellation and can be entered with an already-mutated map
**File:** `src/scripts/features/trlconf/index.js:2993-3129`, handler at `4127-4154`

`_rematchReelEvents` shows a progress strip but never checks `state.visualMatchCancel` in its
per-event loop (`index.js:3044-3103`), so the Stop button cannot interrupt a manual-override
re-match. Separately, the change handler mutates the reel-map entry (`index.js:4143-4149`) *before*
calling `_rematchReelEvents`, which then early-returns if `state.visualMatchRunning` is true
(`index.js:2994`). If a user changes the Fix dropdown while a full match is running, the map entry is
altered but the events are not re-matched, leaving map/corrections transiently inconsistent until the
next run. Low likelihood and self-healing on the next full run, but worth noting.

#### LOW (pre-existing, general state) — reel keyed by clip name is never slipped or re-matched
**File:** `_buildReelMap` `index.js:944` vs. `_applyReelSlips` `index.js:914` and new
`_rematchReelEvents` `index.js:2997-2998`

`_buildReelMap` derives the proxy key as `reel || srcFile || clipName`, but `_applyReelSlips` and the
new `_rematchReelEvents` match events with `reel || srcFile` only (no `clipName` fallback). For a
timeline whose events carry only `clipName` (no reel/srcFile), the reel exists in the map but no
event ever satisfies the filter, so neither reel-slip nor the new manual re-match touches it. This
is a pre-existing inconsistency that today's `_rematchReelEvents` inherits rather than introduces.

#### LOW (pre-existing, general state) — non-drop-frame timecode math applied to all timelines
**File:** `src/scripts/features/trlconf/index.js:41-46` (`_tcToFrames`), mirrored in
`src/scripts/modules/conform/edlParser.js:20-26`

`_tcToFrames` matches both `:` and `;` separators but computes frames as `(hh*3600+mm*60+ss)*fps+ff`
with no drop-frame compensation. For genuine 29.97 drop-frame timelines this yields a systematic
frame-offset error in every TC↔frame conversion (slip math, ETA-unrelated). Pre-existing, consistent
with the app's 24fps default, and not touched today — noted for completeness of the "general state"
review. `pictureMatcher.js` (the live conform module) is arithmetically correct: the 4×4/16-cell
robust dHash and the "sum the best 10, discard the worst 6" distance metric (`MAX_DISTANCE=640`) are
internally consistent with their documentation.

## Log-vs-reality assessment
The coding log is **accurate**. Every claimed function, element id, state field, persistence
touch-point, and CSS class is present in the live source, and the auditor-run `test:js` /
`build:renderer` / XSS-gate results match the log's claimed pass results. The log's own scope
discipline notes (matching/scoring/threshold logic in `pictureMatcher.js`/`audioMatcher.js`/
`_matchEventByVisualWave`/`_buildReelMap` left unedited) are corroborated by `git diff` showing the
conform module content unchanged. The one thing the log does **not** surface is the MEDIUM finding
above — it describes the manual override as producing "the same field shape `_buildReelMap` would
produce" and being "treated identically to an auto-detected one from this point on," but does not
note that a subsequent `_buildReelMap` rebuild (on Run Auto-Conform / re-index) discards it.
