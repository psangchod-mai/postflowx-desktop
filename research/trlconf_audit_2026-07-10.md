# Trailer Conform — Audit of 2026-07-10 "Approve All SAFE" change

Scope: independent verification of `research/trlconf_coding_log_2026-07-10.md`'s claims
about a change to `src/scripts/features/trlconf/index.js`, plus an opportunistic read of
`src/scripts/modules/conform/pictureMatcher.js` and `audioMatcher.js` (neither of which
was touched by this change).

This directory is not a git repo, so verification was done by reading the current file
content directly rather than via `git diff`.

## Verification of `npm run test:js` / `npm run build:renderer`

Both commands were re-run from scratch, independent of the coding log's claims.

- **`npm run test:js`**: ran all 75 files matched by `tests-js/*.test.mjs` (the script is
  a shell loop over every file in that directory, not just two suites). Exit code `0`.
  Every suite printed `N passed, 0 failed`. One suite (`otioParser.test.mjs`) prints a
  `console.error`-style line (`parseOTIO failed SyntaxError: Expected property name or
  '}' in JSON...`) as part of a deliberate malformed-input test case — this is expected
  output from an intentional negative test, not a failure; the suite still reports
  `N passed, 0 failed` immediately after it. No suite anywhere in the run reported a
  nonzero failure count. **Verified: test:js genuinely passes in full**, including but
  not limited to the two suites the coding log specifically quoted
  (`watchFolderPropose.test.mjs` → 25 passed, 0 failed; `watchFolderSettle.test.mjs` →
  22 passed, 0 failed).
- **`npm run build:renderer`**: succeeded, exit code `0`. Output:
  `✓ desktop → dist/desktop/  (361 files, v2026.6.1, ...)` — matches the coding log's
  claimed file count and version exactly (only warning: `GOOGLE_DESKTOP_CLIENT_ID not
  set`, a pre-existing unrelated warning, not an error).

**Discrepancy in how the log reported this (see findings list, Low severity):** the log
labels one of the two suites it quotes as the "edlPipeline suite." No file named
`edlPipeline*` exists in `tests-js/`; the "25 passed, 0 failed" output the log quotes
actually belongs to `tests-js/watchFolderPropose.test.mjs`. The log also implies these
were "the" test results without disclosing that `test:js` runs ~75 suites total (all of
which did pass) — it only surfaced the last two suites' tail output. The bottom-line
pass/fail claim ("no regressions," both checks passed) is true, but the suite name/scope
framing is inaccurate/incomplete.

## Does the code match the coding log's claim?

**Yes, materially.** All three described pieces of the change exist and behave as
described, with only minor line-number drift (the log's line numbers were estimates
made before/during editing, actual numbers below):

1. **Markup** — `index.js:1390`: `<button class="trc-btn" id="trcBtnApproveAllSafe" title="Approve every SAFE row in one click" style="display:none">Approve All SAFE</button>`, placed inside `.trc-panel-head` directly after `#trcResultsStats` (`index.js:1389`). Matches claim (log said "~line 1389").
2. **Render logic** — `index.js:1822-1831`, inside `_renderMatchResults()`, immediately after the SAFE/REVIEW/FAIL stats computation (`index.js:1815-1820`):
   ```js
   const approveAllBtn = _$('trcBtnApproveAllSafe');
   if (approveAllBtn) {
     const unapprovedSafeCount = visibleEvents.filter(e =>
       _computeRowStatus(e.id) === 'SAFE' && !_isEventApproved(e.id)
     ).length;
     approveAllBtn.style.display = unapprovedSafeCount > 0 ? '' : 'none';
     approveAllBtn.textContent = unapprovedSafeCount > 0
       ? `Approve All SAFE (${unapprovedSafeCount})`
       : 'Approve All SAFE';
   }
   ```
   Matches claim: shown only when ≥1 visible SAFE-and-unapproved event exists, label includes live count. (Log said "~line 1815"; actual block is 1822-1831, i.e. right after, as described.)
3. **Click handler** — `index.js:3527-3539`, positioned immediately before the `trcBtnApproveMatch` wiring at `index.js:3542` (log said "new block just before the existing trcBtnApproveMatch wiring, ~line 3515" — actual start is 3527, same relative position):
   ```js
   _$('trcBtnApproveAllSafe')?.addEventListener('click', () => {
     const visibleEvents = _getVisibleEvents();
     for (const ev of visibleEvents) {
       if (_computeRowStatus(ev.id) !== 'SAFE') continue;
       const meta = _getMatchMeta(ev.id);
       if (!meta.status || meta.status === 'UNMATCH') meta.status = 'SAFE';
       meta.approved = true;
     }
     _renderMatchResults();
     _renderExportSummary();
     _updateStatusBadges();
     _updateExportBtns();
   });
   ```
   Confirmed this is a byte-for-byte equivalent (for the SAFE-only subset) of the existing per-row `data-act="approve"` delegated handler at `index.js:3677-3682`:
   ```js
   if (act === 'approve') {
     const algStatus = _computeRowStatus(evId);
     if (!meta.status || meta.status === 'UNMATCH') {
       meta.status = (algStatus === 'FAIL' || algStatus === 'UNMATCH') ? 'REVIEW' : algStatus;
     }
     meta.approved = true;
   }
   ```
   Since the loop already filters to `algStatus === 'SAFE'`, the `? 'REVIEW' : algStatus` ternary in the per-row version always resolves to `algStatus` (`'SAFE'`) in that case, so the two are logically identical for SAFE rows — the log's "mirroring the per-row handler exactly, just looped" claim is accurate. The four follow-up calls (`_renderMatchResults`, `_renderExportSummary`, `_updateStatusBadges`, `_updateExportBtns`) also match every other approve/reject/review handler in the file exactly.
4. No other files were touched — confirmed by reading `pictureMatcher.js`/`audioMatcher.js` and the rest of `index.js`; no matching/threshold/export/verify logic was altered outside the three blocks above.

No git commit/push and no `.app` packaging were run, consistent with the log's "Not done" section (nothing to verify there beyond taking the claim at face value, since this is a no-git repo and no packaging artifacts were requested to be checked).

## Findings

### Medium
- **`index.js:1701-1719` (early-return branch of `_renderMatchResults`) vs. `index.js:1822-1831` (new button-visibility logic) — stale "Approve All SAFE" button on transition to zero visible events.**
  The new button lives in `.trc-panel-head` (`index.js:1390`), a sibling of `#trcResultsWrap`/`#trcEmptyState`, not a child of either. `_renderMatchResults()` has an early-return path (`index.js:1713-1719`) that runs whenever `_getVisibleEvents()` is empty; that path hides the results table/empty-state and clears `#trcResultsStats`, but never touches `#trcBtnApproveAllSafe` — it returns *before* reaching the block at 1822 that would hide/reset it.
  **Concrete failure scenario:** load a cut, run Auto Match, get some SAFE rows, note the button now reads e.g. "Approve All SAFE (5)" and is visible. Clear the loaded cut (`trcClearCut`, wired via `_onCutFiles(null)` at `index.js:3181-3209`, which sets `state.events = []` and then calls `_renderMatchResults()`). The results table and empty-state correctly toggle, but the "Approve All SAFE (5)" button remains visible with its stale count and label, floating in the now-otherwise-empty panel head. Clicking it is harmless (the click handler's `_getVisibleEvents()` loop is a no-op on an empty event list, so no state corruption results), but it is a visibly broken/misleading control — a dead, stale-labeled button with no rows underneath it, contradicting the intended "hidden by default, shown/updated only when relevant" design describe in the coding log.
  **Fix direction (not applied, per audit scope):** add `if (approveAllBtn) approveAllBtn.style.display = 'none';` to the early-return branch, or move the button visibility/label update above the early return.

### Low
- **Coding log accuracy — `research/trlconf_coding_log_2026-07-10.md`, "Verification" section.** The log attributes "25 passed, 0 failed" to an "edlPipeline suite," but no `edlPipeline*` test file exists in `tests-js/`; that specific output actually belongs to `tests-js/watchFolderPropose.test.mjs`. The log also only surfaces the tail two suites of a ~75-suite `npm run test:js` run without noting the other ~73 suites exist/passed too, making the verification section read as more narrowly-scoped than the actual command run. The underlying pass/fail claim ("no regressions," both checks passed) is independently confirmed true, but the suite naming is factually wrong and the framing is incomplete.

### Info (no action needed, opportunistic notes)
- **Redundant double render in the new handler (pre-existing pattern, not a new bug):** the new click handler at `index.js:3527-3539` calls `_renderMatchResults()` then `_renderExportSummary()`, but `_renderMatchResults()` itself already calls `_renderExportSummary()` internally at `index.js:1833`. This causes one harmless extra `_renderExportSummary()` pass per click. This exact redundancy already exists in every other handler in the file (`trcBtnApproveMatch`, `trcBtnRejectMatch`, `trcBtnMarkReview`, the `data-act` delegated handler, `trcBtnResetMatch`), so the new code is consistent with (not a regression introduced by) existing style — flagged only for completeness, not attributable to this change.
- **No security issues found in the diff.** The new button's label is set via `approveAllBtn.textContent = ...` (`index.js:1828-1830`), not `innerHTML`, so there is no injection surface even though the count is dynamic. The new click handler contains no `eval`, `Function` constructor, `child_process`/shell-out, or filesystem path handling of any kind — it only mutates `state.matchResults` via the existing `_getMatchMeta` helper. `pictureMatcher.js` and `audioMatcher.js` (read opportunistically, unmodified by this change) also contain no eval/shell-out/unsanitized-path code.
- **No state-mutation regression found for `_shouldApplyCorrection` / `_getExportSummaryData` / export XML generation.** Both functions key off `_computeRowStatus(ev.id)` and `_isEventApproved(ev.id)`, reading the same `state.matchResults[evId].{status,approved}` fields the new handler writes via the same `_getMatchMeta` helper used everywhere else. The new bulk handler only ever sets `meta.status` when it is currently unset/`'UNMATCH'` and only ever to `'SAFE'` (and only for rows whose `_computeRowStatus` is already algorithmically `'SAFE'`), and always sets `meta.approved = true` — a strict subset/no-op-safe version of the existing single-row approve semantics. It never touches `state.eventCorrections`, so rows with `approved:true` but no underlying correction still correctly fall through `_shouldApplyCorrection`'s `if (!corr) return false;` guard (`index.js:1549-1551`) exactly as they did before this change, for both bulk- and single-approved rows.
- **No double-binding / listener-leak risk found.** The new `addEventListener` call is inside `mount()` (`index.js:3159-3777`), which is invoked once per full panel (re)mount; each `mount()` call first replaces `mountEl.innerHTML` (`index.js:3162`), destroying any prior `#trcBtnApproveAllSafe` element (and its listeners) before a fresh element and a fresh listener are created. The only other `mount()` call site (`index.js:3839`, inside the "clear all state" path) follows this same replace-then-rebind pattern already used by every other button in the panel, so this is consistent with existing, presumably-already-relied-upon behavior rather than a new risk.
