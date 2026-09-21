# Trailer Conform — Audit
_2026-07-13 · read-only security & correctness audit_

## 1. Scope & what was reviewed
Independent, read-only audit of the Trailer Conform feature and today's coding job.

Files read:
- `src/scripts/features/trlconf/index.js` (~173 KB, read in chunks + full working-tree diff)
- `src/scripts/features/trlconf/ai_matcher.js`, `fp_worker.js` (unchanged in the diff)
- `src/scripts/modules/conform/audioMatcher.js`, `edlParser.js`, `pictureMatcher.js`, `timelineFormats.js`
- Supporting: `src/scripts/modules/native_helper_client.js` (session APIs)

Context read first: today's coding log (`trlconf_coding_log_2026-07-13.md`), the prior coding logs and audits for 07-10/11/12, `CLAUDE.md`, `PROJECT_MAP.md`.

Tooling run (read-only): `npm run test:js`, `npm run build:renderer`, `node tools/scan-innerhtml.mjs [--gate]`, `node tools/scan-rawxml.mjs`, `git diff`.

No source/config/test file was modified. The only file written is this report.

---

## 2. Independent verification (run by the auditor, not trusted from the log)

### `npm run test:js`
- **Exit code: `0`.**
- 76 suites executed (`tests-js/*.test.mjs`). Every suite reported `N passed, 0 failed`; a grep for `[1-9][0-9]* failed` across the full 108 KB of output returned **zero** matches.
- The two final suites are `watchFolderPropose.test.mjs` → **25 passed, 0 failed** and `watchFolderSettle.test.mjs` → **22 passed, 0 failed** — exactly the "25 / 22 passed" the 07-13 log quotes.
- Conform-relevant suites all green: `conformWiring`, `edlParser` (16), `pictureMatcher` (6), `fpsMatch`, `edlExport`, `timelineModel`, `otioParser`, `aafParser` (17). The lone `parseOTIO failed SyntaxError…` console line is the expected output of an intentional malformed-input negative test (that suite still reports `15 passed, 0 failed`), consistent with prior logs.

### `npm run build:renderer`
- **Exit code: `0`.**
- Final line: `[build-renderer] ✓ desktop → dist/desktop/  (361 files, v2026.6.1, 2026-07-13 14:43 UTC)`.
- The `GOOGLE_DESKTOP_CLIENT_ID not set` line is a pre-existing config warning, unrelated to this feature.

### Comparison to the 07-13 log's claims
**Both match.** The log claimed `test:js` passed with final suites "25 passed / 22 passed" (exit 0) and `build:renderer` succeeded with "361 files, v2026.6.1" — all independently confirmed. The only difference is the build's UTC timestamp (log `07:52`, my run `14:43`), which simply reflects a different run time and is expected.

### Security scanners
- `node tools/scan-innerhtml.mjs --gate` → **`✓ XSS gate clean`**, exit 0. The heuristic (non-gate) list has **no** hits in `trlconf/` or `conform/`.
- `node tools/scan-rawxml.mjs` → **0 raw XML parse entrypoints found**, exit 0.

---

## 3. Log-vs-reality assessment

**The 07-13 log's claim is credible and confirmed for what it describes.** The seven `#trcPhStep0..6` label rewrites are present in the working tree exactly as documented (`index.js:1358–1377` in the diff):

| id | old | new |
|----|-----|-----|
| trcPhStep0 | Parsing XML | Reading your cut |
| trcPhStep1 | Sampling reference frames | Looking at the reference picture |
| trcPhStep2 | Reading reference audio | Listening to the reference sound |
| trcPhStep3 | Indexing source frames | Scanning source picture |
| trcPhStep4 | Indexing source audio | Scanning source sound |
| trcPhStep5 | Solving offsets | Lining everything up |
| trcPhStep6 | Done | Finished |

Element ids, classes, `&#8250;` arrow separators, and the dynamic `#trcProgressCurrent` element are untouched. `_setMatchPhaseActive` (toggles `.trc-phase-active` by index, never reads `textContent`) is unchanged, so the copy change cannot affect phase-highlighting behavior — the log's safety analysis is accurate.

### On the "undocumented changes" question — no discrepancy attributable to today
The repo has a single commit (`cfb6f29`), so `git diff` is the **cumulative** uncommitted diff across many sessions. `git diff --stat` shows `index.js` at ~425 changed lines / 340 insertions. That diff contains far more than the seven labels, e.g.:
- Migration from mean-hash (`_computeHash`/`_hammingDistance`/`_grabHash`/`_mHashSimilarity`) to region-robust hashing (`regionalHash`/`regionalDistance`/`distanceToConfidence` from `pictureMatcher.js`);
- "Part B" live scrubbable verify playback (~150 lines: `_prepareVerifyVideo`, `_teardownVerifyVideo(s)`, `_verifyRedrawFrame`, rAF loop, Sync-Scrub button/state);
- Blind-ProRes decode handling in `_loadVideo`, a 20 s timeout in `_loadVideoFromUrl`, `_assertDecodable`;
- CSV formula-injection escaping in the export `esc()` helper;
- Source-index failure counting (`ok++` on catch → `failed++`);
- The 07-10/11/12 logged work (Approve-All-SAFE, pre-export confidence gate + `unmatched` count, results guide/legend/summary, de-jargoned AI-MATCH note).

**These are not today's work.** They map to the three prior documented sessions (07-10/11/12) plus older, pre-07-10 unlogged work. The 07-12 audit already explicitly documented the `regionalHash` import, `_computeHash` removal, and the `100644→100755` mode change as *prior-pass* work ("region-robust picture hashing, already listed as shipped"). Part B live-scrub and the blind-decode handling appear in none of the four provided logs (a daily series that instead describe other items on those days), which places them before 07-10. Git alone cannot isolate a single day, but there is **no evidence that today bundled any undocumented logic change** — the only edits consistent with a "pure static-text pass with a 2026-07-13 mtime" are the seven labels, and the file's mtime (`2026-07-13 14:44`) is consistent with a single same-day save.

Minor note carried forward from the 07-12 audit: the file mode is `100755` (executable bit set) — cosmetic, not introduced today.

---

## 4. Findings (ranked by severity)

### Critical — none.
Checked: no `eval`, no `new Function`, no `child_process`/`spawn`/`exec`/`execFile`/`execSync`, no filesystem/path handling, no path traversal anywhere in `trlconf/` or `conform/` (grepped). No raw-XML injection sink (scan-rawxml = 0). No unescaped untrusted data into `innerHTML` (scan-innerhtml gate clean).

### High — none.

### Medium

**M1 — Verify-panel resource/listener leak on `clear()` and remount (CONFIRMED; pre-existing, not from today).**
`src/scripts/features/trlconf/index.js:3850` (`clear()`) → `:3208` (`mount()`).
`_teardownVerifyVideos()` (`:1961`) is invoked from **only one place**: the Close-Verify button handler (`:3627`). `clear()` resets ~30 `state` fields but never calls `_teardownVerifyVideos()`, never resets the Part B fields (`_refVideoEl`, `_srcVideoEl`, `_refSessionId`, `_srcSessionId`, `_refTransportOff`, `_srcTransportOff`, `_verifyRafId`, `_verifyFileKeys`, `_refVideoUrl`, `_srcVideoUrl`), and then calls `mount()`, which does `mountEl.innerHTML = _buildHTML()` (`:3208`) — destroying the `<video>` DOM nodes.
Consequence, with the Verify panel open (ref/src videos loaded) when `clear()` runs:
- the native media session opened via `sharedMediaOpen` is **never** closed (`sharedMediaClose` in teardown is skipped) → the companion/shared runtime keeps the file open;
- `attachResolveTransport`'s detach fn (`_refTransportOff`/`_srcTransportOff`) is never called → transport listeners left bound to now-detached `<video>` elements (which `state._refVideoEl`/`_srcVideoEl` still reference);
- blob object URLs (`_refVideoUrl`/`_srcVideoUrl`) are not revoked;
- if a video was playing at clear-time, the `requestAnimationFrame` loop (`_verifyRafId`) is not cancelled.
Realistic scenario: an operator opens Verify on an event, then clicks the Clear-cut control (`clear()` is also called from `applyState` at `:3914` when there is no saved analysis). Repeating load → verify → clear cycles accumulates open native sessions, detached-element listeners, and un-revoked blob URLs — a steadily growing leak over a working session.
Fix direction: call `_teardownVerifyVideos()` at the top of `clear()` (before `mount()`), and reset the Part B `_ref*/_src*/_verify*` state fields there; optionally also tear down on panel unmount if the app ever unmounts the feature.

### Low

**L2 — Stale "Approve All SAFE" button when visible events drop to zero (CONFIRMED; carry-over of the 07-10 Medium finding, still unfixed).**
`_renderMatchResults` early-return branch (`index.js:~1724–1735`). When `_getVisibleEvents()` is empty the function hides `#trcEmptyState`/`#trcResultsWrap`/`#trcResultsGuide` and clears `#trcResultsStats`, then returns — **before** reaching the block (`:~1866`) that shows/hides/relabels `#trcBtnApproveAllSafe`. `#trcBtnApproveAllSafe` lives in `.trc-panel-head` (a sibling, not a child of the wrap/empty-state), so a previously-shown "Approve All SAFE (N)" button stays visible with a stale count after the cut is cleared/filtered to empty. Clicking it is harmless (the handler's loop is a no-op on an empty event list), so this is cosmetic/misleading only. The 07-12 change added a `guideEl` hide to this same branch but did not add the analogous button hide.
Fix direction: add `const b=_$('trcBtnApproveAllSafe'); if(b) b.style.display='none';` to the early-return branch (or move the button-visibility update above the early return).

**L3 — Plain-language summary sentence omits MANUAL-status rows (CONFIRMED; carry-over of the 07-12 Low finding).**
`index.js:~1852–1866`. The summary buckets rows into SAFE/REVIEW/FAIL/UNMATCH and computes `needAttention = reviewN + failN + unmatchN`; `_computeRowStatus` can also return `'MANUAL'`, which is counted in none of the buckets. E.g. 6 SAFE + 2 REVIEW + 2 MANUAL of 10 renders "6 of 10 … 2 events need your attention" (6+2≠10), and an all-SAFE-plus-MANUAL cut reads "All N events matched automatically," mislabeling manual fixes as automatic. Accuracy nit for a non-technical audience; no crash, MANUAL rows still export correctly.
Fix direction: include MANUAL in the arithmetic (either as an "approved/handled" bucket or in the total accounting).

**L4 — `_loadVideoFromUrl` timeout rejects but does not abort the pending request (SUSPECTED; minor).**
`index.js:~502–520`. The added 20 s timeout calls `cleanup()` (clears the timer, removes the `loadedmetadata`/`error` listeners) and rejects, but does not `video.removeAttribute('src')` + `video.load()`, so a stalled companion stream keeps the detached `<video>` and its in-flight network fetch alive until GC. Low impact (bounded, one element per stalled load) and the added timeout is itself a net improvement over the prior "stuck on Loading… forever" behavior.
Fix direction: in the timeout/error cleanup, also null the src and call `load()` to abort.

### Info / positives (no action required)

- **CSV formula-injection hardening is correct.** The export row builder's `esc()` (`index.js:~3035`) now prefixes a `'` to any value matching `/^[=+\-@\t\r]/` before quoting — this neutralizes spreadsheet formula injection via attacker-influenced free-text fields (clipName/reel/master stem/event label), which are the only fields routed through `esc()`. The remaining unescaped CSV columns (`recIn`, `recOut`, `corrSrcIn`, `corrSrcOut`, `offsetStr`, the `%` values, `status`) are internally-computed timecodes/numbers/enums, not attacker-controlled text — no injection surface.
- **No XSS in the feature.** The results table (`index.js:1741`) and slip summary (`:1694`) escape every untrusted event field (`clipName`, `reel`, master names, TCs) via `_esc`; only numeric/enum values (`audioPct`, `status`, internal `ev.id`) are interpolated raw. `_buildHTML()` (`:3208`) is a static template; the re-auth chip (`:3838`) uses `_esc(name)`. Matches the gate-clean scan.
- **Hashing migration is clean.** No dangling references to the removed `_computeHash`/`_hammingDistance`/`_grabHash`/`_mHashSimilarity`. `_HASH_BITS` is still legitimately used by the surviving edge-hash / luma path (`_computeFrameLuma`, `_computeEdgeHash`, `_eHashSimilarity`). The fingerprint cache key prefix was correctly changed `h|…` → `rh|…` to avoid mixing old mean-hash and new regional-hash cache entries. `pictureMatcher.js` math checks out: 4×4 grid, 64-bit dHash/cell, discards the 6 worst cells (16−10), `MAX_DISTANCE=640`, `distanceToConfidence` clamps to 0–100.
- **`_computeReelSlips` id-comparison fix is correct** (`index.js:882`): `String(e.id) === String(evId)` guards against number-vs-string id mismatch between `events[].id` and the `Object.entries(eventCorrections)` string keys — prevents silently dropping reel-slip contributions.
- **Proxy-transcode verify loads don't capture a `sessionId`** for `sharedMediaClose`: `_loadVideo` returns `sessionId` only on the native-stream fast path (`:420`); the proxy-transcode path returns `proxySessionId` instead. So `_prepareVerifyVideo` (`state[sessKey] = loaded.sessionId || null`) closes native sessions but not proxy sessions. This is **by design** (proxy sessions are not native-runtime sessions closed via `sharedMediaClose`) and is not a regression versus the pre-Part-B behavior, which closed nothing — noted only for completeness.
- **Parsers are safe.** `edlParser.js` uses `DOMParser` (no script execution) and `JSON.parse` in try/catch; `timelineFormats.js` is pure with no DOM/IO; `audioMatcher.js` is pure math. No path handling, no shell-out.

### Regressions vs existing tests — none.
`npm run test:js` is fully green (exit 0), including `conformWiring`, `edlParser`, `pictureMatcher`, `fpsMatch`, `edlExport`, `otioParser`, `aafParser`, `timelineModel`. No suite references the `trcPhStep*` ids or the reworded strings, so today's copy change cannot regress any test — and none did.

---

## 5. Summary
- **Build/tests: both pass, exit 0** (`test:js` all suites `N passed, 0 failed`, final 25/22; `build:renderer` → `✓ desktop → dist/desktop/ (361 files, v2026.6.1)`). Matches the 07-13 log exactly.
- **Log matched reality:** the seven progress-label rewrites are present verbatim and are logic-inert; no undocumented change is attributable to today. The large cumulative `git diff` is prior-session/pre-log work (single-commit repo), consistent with the earlier audits.
- **Top findings:** No Critical/High. One **Medium** (M1: verify-panel native-session / listener / blob-URL leak because `clear()`→`mount()` skips `_teardownVerifyVideos()`); Lows are two carry-over cosmetic/accuracy nits (stale "Approve All SAFE" button; MANUAL rows omitted from the summary sentence) and a minor un-aborted timeout request. Security posture is good: no eval/shell/path sinks, XSS gate clean, and the CSV export now guards against formula injection.
</content>
</invoke>
