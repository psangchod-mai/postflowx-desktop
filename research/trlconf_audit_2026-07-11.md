# Trailer Conform — Audit of 2026-07-11 Coding Session

_Auditor pass, read-only. Verifies claims in `research/trlconf_coding_log_2026-07-11.md`
against the actual current content of `src/scripts/features/trlconf/index.js`, and
independently re-runs the test/build commands rather than trusting the log's reported
results._

## Verification of `npm run test:js` / `npm run build:renderer`

Both commands were re-run independently from the repo root, today, against the current
working tree (not a git repo, so this reflects whatever is on disk right now).

**`npm run test:js`**
- Exit code: `0`.
- 75 test files executed (`grep -c "^• "` on the raw output = 75).
- Every single suite reported `N passed, 0 failed`; grep for `[1-9][0-9]* failed` across
  the full output returned zero matches — i.e. no suite had any failing assertion.
- The one non-"PASS" anomaly line, `parseOTIO failed SyntaxError: Expected property name
  or '}' in JSON at position 1 (line 1 column 2)` (inside `tests-js/otioParser.test.mjs`,
  which itself reported `15 passed, 0 failed`), is a `console.error`/log line emitted by an
  intentional malformed-JSON test case, not a failed assertion. This matches the coding
  log's characterization of that line.
- Conclusion: the log's claim of "every suite reported N passed, 0 failed" is **accurate**.

**`npm run build:renderer`**
- Exit code: `0`.
- Output: `[build-renderer] ✓ desktop → dist/desktop/  (361 files, v2026.6.1, 2026-07-11
  12:18 UTC)`.
- One pre-existing, unrelated warning: `GOOGLE_DESKTOP_CLIENT_ID not set — Google login
  will be disabled in this build` — this is an environment/config warning independent of
  the Trailer Conform change and does not affect renderer output or file count.
- Conclusion: the log's claim of a successful build (`361 files, v2026.6.1`) is
  **accurate** — file count and version match exactly.

## Does the code match the coding log's claim?

**Yes, with only a trivial line-number discrepancy.**

Confirmed in `src/scripts/features/trlconf/index.js`:

- `_confirmExportWithPendingReviews()` exists at line **2900**, immediately above
  `_exportCorrectedXML()`, exactly as claimed:
  ```js
  function _confirmExportWithPendingReviews() {
    const summary = _getExportSummaryData();
    const pending = summary.reviewUnapproved + summary.fail;
    if (pending <= 0) return true;
    const bits = [];
    if (summary.reviewUnapproved > 0) bits.push(`${summary.reviewUnapproved} still need review`);
    if (summary.fail > 0) bits.push(`${summary.fail} failed to match`);
    return confirm(`${pending} event(s) ${bits.join(' and ')} before export. Export anyway?`);
  }
  ```
- The gate `if (!_confirmExportWithPendingReviews()) return;` is wired into
  `_exportCorrectedXML()` at line **2912** (log said "~line 2911" — off by one line, not a
  material discrepancy), right after the pre-existing `if (!state.analyzed ||
  !state.events.length) return;` guard at line 2911, and before any XML string building
  begins (first XML-building code starts at line 2913 with `const fps = ...`).
- Confirmed the early-return-when-clean semantics: `pending <= 0` (i.e.
  `reviewUnapproved + fail === 0`) returns `true` with no `confirm()` call, so the common
  "everything's clean" case is provably unchanged from before this patch — no new dialog
  appears for a fully-approved cut.
- Confirmed `confirm()` correctly gates export: when the user clicks Cancel, `confirm()`
  returns `false`, `_confirmExportWithPendingReviews()` returns `false`, and
  `_exportCorrectedXML()` returns immediately via the new line — no XML is built, no
  `_download()` call happens.
- Confirmed the single other XML-export entry point: line **3907**,
  `if (fmt === 'xml') _exportCorrectedXML();` inside the quick-export dispatcher, calls
  `_exportCorrectedXML()` directly (not some parallel code path), so it automatically goes
  through the new gate. Grepped the whole file for every call site of
  `_exportCorrectedXML` — there are exactly two: the button click handler at line 3520
  (`_$('trcBtnExportXML')?.addEventListener('click', _exportCorrectedXML)`) and the
  dispatcher at line 3907. Both funnel through the same gated function; there is no bypass.
- Confirmed no other exported/CSV code path was touched: `_exportCSVPullList()` (starts
  line 2978) has no gate and was not modified, matching "No ... CSV export logic was
  touched" in the log.
- Confirmed the previously-known issue (Approve All SAFE button not hidden by the
  `_renderMatchResults()` early-return at lines 1713-1719 when the visible event list is
  empty) is **unchanged** — this code region was not touched by the new commit; the
  early-return still only clears `trcResultsStats` text and toggles
  `trcEmptyState`/`trcResultsWrap` display, with no reference to
  `trcBtnApproveAllSafe`. Still just the known low-severity issue, not regressed further.

## Findings

### Medium
- **`src/scripts/features/trlconf/index.js:1574-1582` (`_getExportSummaryData`, pre-existing, inherited by the new gate) — events with status `UNMATCH` are silently excluded from both `reviewUnapproved` and `fail`, so the new pre-export gate will not warn about them.**
  `_computeRowStatus()` (line 1658) returns `'UNMATCH'` for any event that has no
  `eventCorrections` entry at all (e.g., match was never run for that event, or a source
  file was never indexed for it). `_getExportSummaryData()`'s loop only increments counters
  for `'SAFE'`, `'REVIEW'`, and `'FAIL'` — an `UNMATCH` event increments none of them. The
  new gate is built entirely on `reviewUnapproved + fail`, so a cut containing exclusively
  `UNMATCH` events (visual match never run, or run against a subset of the timeline) would
  report `pending = 0` and export silently with **zero user warning**, even though those
  events have no meaningful source-file mapping at all — arguably a worse state than
  `REVIEW`/`FAIL`.
  - Failure scenario: A coordinator loads a timeline plus only some of the required source
    files, clicks Export XML before ever running Auto Match on the remaining reels. Those
    reels' events are `UNMATCH`, `reviewUnapproved`/`fail` are both 0, and export proceeds
    with no confirmation dialog at all, producing an XML with fallback/proxy paths for
    events the coordinator may not realize were never actually matched.
  - Note: this gap is **not new** — the same undercount already exists in the on-screen
    stats (`trcSumReviewUnapproved`/`trcSumFail`, rendered from the same
    `_getExportSummaryData()` at lines 1839-1845) that this task's own source idea (idea #1
    in `trlconf_improvements_2026-07-11.md`) explicitly cited as "the numbers needed to
    warn." The new gate faithfully inherits an existing display gap rather than introducing
    a new one, but because the gate's entire value proposition is catching pre-export
    oversights, this gap meaningfully undercuts it for any timeline with un-run matches.

### Low
- **`src/scripts/features/trlconf/index.js:2907` — the confirm() message string is grammatically awkward and could be misread at a glance.**
  `` `${pending} event(s) ${bits.join(' and ')} before export. Export anyway?` `` produces,
  e.g., `"5 event(s) 3 still need review and 2 failed to match before export. Export
  anyway?"`. The leading `"5 event(s)"` immediately followed by `"3 still need review"`
  reads as two different counts glued together without a verb connecting them ("event(s)
  [what?] 3 still need review..."), which could momentarily read as a typo/duplicate count
  rather than "5 events total, of which 3 need review and 2 failed." Not misleading in a
  way that would cause a wrong decision (the sub-counts are correct and unambiguous once
  read fully), but not the clean plain-language sentence idea #1 in the source research
  document was aiming for. Cosmetic/wording issue only.

### Info
- **Line-number drift in the coding log**: log says the gate line is "~line 2911"; actual
  line is 2912 (one line later, because the pre-existing guard occupies line 2911). This is
  an approximate reference (log uses "~") and not a substantive discrepancy — recorded for
  completeness only.
- **No security issues found in the new code**: the new function only calls the native
  `confirm()` global with a string built from numeric counts (`reviewUnapproved`, `fail`)
  that are computed internally, not user-supplied text; there is no `innerHTML`/
  `insertAdjacentHTML` call in either the new function or the one-line gate, so the
  existing `_esc()` escaping convention used elsewhere in the file is not applicable here
  and its absence is not a gap. No `eval`/`Function` constructor, no `child_process`/shell
  invocation, and no filesystem path derived from user input anywhere in the diff. (Grepped
  the whole file plus `pictureMatcher.js`/`audioMatcher.js` for
  `eval(`/`new Function`/`child_process`/`execSync`/`exec(`/`spawn(` — zero matches in all
  three files.)
- **No exception-safety issue**: `_getExportSummaryData()` is a plain internal function
  with no external/IO input; it always returns an object with numeric `reviewUnapproved`
  and `fail` fields (both initialized to `0` and only ever incremented), so
  `summary.reviewUnapproved + summary.fail` cannot throw or produce `NaN` under any state
  reachable through this file's own code paths.
- **No regression to the "Approve All SAFE" empty-state visibility issue**: confirmed
  unchanged (see write-up above) — still the same known low-severity issue described in
  `research/trlconf_audit_2026-07-10.md`, not worsened or fixed by this change.
- **pictureMatcher.js / audioMatcher.js**: read opportunistically per task instructions;
  found nothing related to this change (the diff doesn't touch either file), and no new
  issues were spotted in the regional-dHash / confidence-label code referenced by the
  research notes (`pictureMatcher.js:1-138`, `audioMatcher.js:161-173`) beyond what was
  already catalogued in prior research passes.
