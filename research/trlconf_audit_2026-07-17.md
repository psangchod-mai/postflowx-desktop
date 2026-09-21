# Trailer Conform — Security/Correctness Audit — 2026-07-17

## What was audited
- Today's coding job per `research/trlconf_coding_log_2026-07-17.md` (item #7:
  "show confidence as a plain word next to the Final %").
- General state of the Trailer Conform feature:
  - `src/scripts/features/trlconf/index.js`
  - `src/scripts/modules/conform/` (audioMatcher.js, edlParser.js, timelineFormats.js)
  - `src/styles/main.css` (the `.trc-pct-word` class referenced by the log)
- Read-only. No source files edited/created/moved/deleted (this report is the only file
  written). No git write commands run.

## Repo / dirty state
- Branch: `feature/session-ui-and-playback-fixes`
- HEAD: `cfb6f296` — dated **2026-07-02**, "VFX Pull OCF preview: Resolve seek honors passed OCF start TC".
- Working tree is **dirty and nothing has been committed since 2026-07-02.**
  `git diff` against HEAD therefore shows the **cumulative** uncommitted work of
  every coding job from ~2026-07-10 through today, NOT just today's job. Numstat for
  the audited files: `index.js` +1288/-108, `main.css` +264/-326,
  `theme.postflowx-pro.css` +84/-56. The vast majority of that is prior-day work
  (audits exist for 07-10…07-16); today's job is a tiny subset (see reconciliation).
- The bulk of the raw `git diff` is noise: hundreds of files show only a file-mode
  change `100644 → 100755` with no content change.

## Independent verification (actual results — not the log's claims)

### `npm run test:js`
- **PASS. Exit 0. 22 passed, 0 failed.** Final line: `22 passed, 0 failed`.
- Note: the suite is `tests-js/*.test.mjs`; the covered tests are OCF/file-watch
  ingestion tests (Thumbs.db ignored, junk rejected, batch settle/dedup, proposeAction
  → ocf, etc.). There is **no test that exercises the Trailer Conform results table or
  the confidence-word change** — the change is render-only and untested, but nothing
  regressed.

### `npm run build:renderer`
- **PASS. Exit 0.** `✓ desktop → dist/desktop/ (365 files, v2026.6.1, 2026-07-17 12:19 UTC)`.
- The only warning is `GOOGLE_DESKTOP_CLIENT_ID not set — Google login will be disabled
  in this build`. This is a pre-existing, environment-only warning (missing build-time
  env var), unrelated to the code change. No errors.

Both results match what the coding log claimed.

## Findings by severity

Findings: Critical 0 · High 0 · Medium 0 · Low 1 · Informational 2.

### LOW-1 — Color class and word label use mismatched thresholds (cosmetic inconsistency)
`src/scripts/features/trlconf/index.js:2060-2064` (color class) vs `:2027-2031` (word),
using `confidenceLabel()` at `src/scripts/modules/conform/audioMatcher.js:161-166`.

- The Final % **color** class: `>= 80 → trc-pct-high` (green), `>= 60 → trc-pct-med`
  (amber), else `trc-pct-low` (red).
- The **word** comes from `confidenceLabel(score)`: `>= 0.85 → high`, `>= 0.60 → medium`,
  `>= 0.30 → low`, else `none` (suppressed).
- The two threshold sets do not align in the 80–84% band. A final confidence of, e.g.,
  **82% renders a green ("high"-colored) number but the word "· Medium"** —
  `trc-pct-high` (green, bold) + `confidenceLabel(0.82) = "medium"`.
- Failure scenario: a reviewer scanning the Results table sees a green 82% that reads
  "Medium"; the color and the word disagree about the same number. Purely presentational —
  no data, export, or matching impact. Worth aligning either the class thresholds
  (80/60) or reusing a single source of truth so color and word never contradict.

### INFO-1 — `finalConfidence` division-by-100 conversion is correct (verified, not a bug)
`index.js:2029` computes `finalScore = (corr.finalConfidence ?? corr.confidence ?? 0) / 100`
before calling `confidenceLabel` (which expects 0–1). `finalConfidence`/`confidence` are
consistently clamped to 0–100 at their producers (`index.js:336,356,984,3067,3422`), so
the `/100` is correct and cannot exceed 1. The `?? 0` guards null/undefined; `none` is
suppressed. No off-by-one or NaN path found. Listed only to document that this was checked.

### INFO-2 — `audioPct` is the only Results cell rendered unescaped (pre-existing, not today's change)
`index.js:2078` renders `<td class="trc-col-pct">${audioPct}</td>` without `_esc(...)`,
while every adjacent cell (including the Final % cell touched today, `:2079`) is escaped.
`audioPct` is a numeric confidence string (`` `${corr.audioConfidence}%` ``), not
user/filename-derived, so there is no realistic XSS path today. Flagged as a latent
inconsistency, not an exploitable finding, and it pre-dates this job.

## Security review summary (no findings)
- **XSS sinks:** `innerHTML` used at `index.js:1940, 1989, 2157, 3917, 4605` and
  `_renderSlipSummary`. Every place that interpolates untrusted data (file/master names,
  reel/proxy names, clip names, re-auth account name) wraps it in `_esc()`
  (`_esc` at `index.js:36-40`, escapes `& < > "`). Examples verified: unmatched-reel
  block `:2144-2157` escapes `f.name`, `_stem`, `reason`, `proxyName`; slip chips
  `:1950-1953` escape reel names; re-auth chip `:4605` escapes `name`. No unescaped
  untrusted data reaches an HTML sink.
- **Command injection / shell-out:** No `child_process`, `exec`, `execSync`, `spawn`, or
  `shell:true` anywhere in `src/scripts/features/trlconf/` or `src/scripts/modules/conform/`.
- **`eval` / `new Function`:** none in the audited scope.
- **Path traversal:** the audited renderer code operates on in-memory `File`/media objects
  and TC math; no filesystem path is constructed from user/media names in this scope.
- **Event-listener leaks:** the Results table re-renders by replacing `tbody.innerHTML`
  (`:1989`), but row-action clicks are handled by a **single delegated listener** bound
  once on `#trcResultsBody` using `e.target.closest('.trc-act-btn')` (`:4432-4433`), so
  repeated re-renders do not accumulate listeners.

## Coding-log vs actual-diff reconciliation
The log's specific claims are **all present and accurate**, and the change is minimal and
additive as described:
- Import added: `index.js:11` — `import { confidenceLabel } from '../../modules/conform/audioMatcher.js';`
  (helper confirmed exported at `audioMatcher.js:161`). Path resolves correctly
  (`features/trlconf/../../modules` → `src/scripts/modules`).
- Word computed: `index.js:2027-2031` (log said "~line 2022"; actual ~2027) — capitalizes
  the label, converts 0–100 → 0–1, suppresses `none`. Matches the log verbatim.
- Rendered in the Final % cell: `index.js:2079` —
  `...${_esc(finalPct)}<span class="trc-pct-word">${_esc(finalWord)}</span></td>`. Matches.
- CSS: `main.css:49963` — `.trc-pct-word { font-weight: 400; opacity: 0.75; }`, adjacent
  to the existing `.trc-pct-*` rules. Matches.

**Discrepancy (process, not code):** the log frames the day as a self-contained ~5-line
change, but `git diff` shows +1288/-108 in `index.js`, +264/-326 in `main.css`, and
+84/-56 in `theme.postflowx-pro.css`. This is **not** contradicted by the log — it is a
consequence of the working tree never having been committed since 2026-07-02, so the diff
is the accumulation of every prior coding job (07-10…07-16) plus today's. Today's job
cannot be isolated via git. The claimed hunks are the only trlconf-logic changes
attributable to 2026-07-17; the remaining bulk is prior-day work outside this job's scope
and outside what today's log claims. No "claimed-but-absent" changes; no evidence today's
job introduced anything beyond what the log states.

## Bottom line
Today's change is correct, safe, and matches the log. Both required commands pass
(test:js 22/0, build:renderer exit 0). The only concrete new nit is LOW-1 (color vs. word
threshold mismatch in the 80–84% band). The one thing a reader should keep in mind is that
git cannot isolate today's job — the working tree carries a week of uncommitted work.
