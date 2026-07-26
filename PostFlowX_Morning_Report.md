# PostFlowX — Morning Report (2026-07-26)

**Run:** 2026-07-25 ~23:50 → 2026-07-26 08:00 · 12 iterations · branch `feature/session-ui-and-playback-fixes`
**Mode:** RESEARCH → CODE → AUDIT per iteration, highest-value item each time.
**Detail:** `PostFlowX_Nightly_Backlog.md` (per-iteration narrative) and `PostFlowX_Audit_Report.md` (findings tables, 16 areas).
*The 2026-06-27 report is preserved below, unchanged.*

---

## Read this first — three things that need your attention

### 1. 🚨 Commit `6e14ec6` contains 319 lines of *your* work, misattributed to me

Iteration 5's commit (`imf: show which decoder is serving frames in the operator HUD`) swept in pre-existing uncommitted changes to `electron/native/imf_player.js`. **My actual contribution was 21 lines added / 1 removed. The commit contains 34 hunks, of which 30 are entirely yours and 1 is mixed.**

**Nothing was lost or altered** — the content is byte-for-byte what was in your working tree. The damage is authorship and reviewability: the commit message describes a HUD change and the diff contains a great deal more. I did not try to fix it unattended, because splitting it means rewriting history on a branch whose intent I can't see.

Tag `loop-history-backup` points at `4ef5a86` if you want to rewind and re-split.

### 2. ✅ Your uncommitted drop-frame work in `edl_export.js` was displaced and restored — please verify

Iteration 11 needed to commit `src/scripts/modules/edl_export.js`, which **already held your uncommitted drop-frame work**: `[:;]` separator regexes in `tcToFrames` and `safeTC`, `buildHeader(..., isDropFrame)` emitting `FCM: DROP FRAME`, and the `isDF` detection block in `buildPartEDL`. `git diff` showed 40 changed lines where mine were 22.

Committing wholesale would have repeated the `6e14ec6` mistake. `git add -p` is interactive and unavailable here, so I: backed the file up, restored it from HEAD, re-applied only my three edits, verified the staged diff was exactly 19 insertions / 3 deletions, committed, then **restored your version over it**.

**Verified byte-identical after restore** (`shasum 6d861aa04e912eec21e86a5572d12bada45ac205`, `diff` clean; `git diff` now shows exactly and only your four drop-frame hunks, 13 insertions / 5 deletions). The backup is at `/tmp/edl_worktree_BACKUP.js` until the machine clears `/tmp` — worth a look before that happens.

### 3. ⚠️ A claim I committed in iteration 10 is wrong and cannot be un-committed

The `8bb0ed6` commit message and audit finding #8 both state that `edl_export.js`'s local timecode functions *"shadow the file's own imports from `utils_time.js`, making those imports dead."* **False — `edl_export.js` had no imports at all.** They were private copies with nothing to shadow. The severity was also understated at Medium; the real consequence was a corrupt REC timeline in a delivered EDL.

Both markdown documents now carry the correction. A commit message can't be amended without rewriting history, so it's flagged here instead.

---

## The headline fix

**Every EDL exported at 23.976, 29.97 or 59.94 had its entire record timeline zeroed.** Every REC IN and REC OUT column read `00:00:00:00`. Integer rates were correct, which is why it survived.

| fps | REC columns emitted |
|---|---|
| 24, 25, 30, 60 | `00:00:00:00 00:00:05:00` / `00:00:05:00 00:00:15:00` ✅ |
| **23.976, 29.97, 59.94** | `00:00:00:00 00:00:00:00` / `00:00:00:00 00:00:00:00` ❌ |

`framesToTC` did `frames % fps` on the *fractional* rate, so a five-second span (119.88 frames) formatted as `"00:00:05:0.12000000000000455"`. That hit `safeTC`, failed its `\d{2}` regex, went through `Number()` to `NaN`, and came back `"00:00:00:00"`.

**Fractional fps reaches the exporter by the ordinary route:** `parseALE` stamps `ev.fps = 23.976` from an ALE header reading `FPS 23.976` (`ale.js:60`, `:173`), and `buildEDLFiles` reads `Number(events[0]?.fps)`. An ALE from a dailies house is the normal input, not an edge case.

Fixed in `e2798bd`. Related: `8bb0ed6` fixed the same class of defect in the app's *lowest-level* timecode pair (`utils_time.js`, ~607 call sites), where `tcToFrames('01:00:00:00', 23.976)` returned 86313 instead of 86400 — a one-hour timecode 3.6 seconds short of itself, and a five-second span measuring 119 frames instead of 120.

## What landed

| # | Commit | Change |
|---|---|---|
| 5 | `6e14ec6` | IMF operator HUD shows which decoder is serving frames — **⚠️ contaminated, see above** |
| 6 | `1497bee` | Latch off the direct HT decoder after repeated failures instead of retrying forever |
| 7 | `4ef5a86` | Stop labelling every classic JPEG 2000 package as HTJ2K |
| 8 | `47b144b` | Converge the last two private SIZ parsers onto `j2kCodestream` |
| 9 | `ef7af92` | ALE: accept drop-frame timecode instead of silently dropping the row |
| 10 | `8bb0ed6` | Timecode: count on the whole-frame base, not the fractional rate (~607 call sites) |
| 11 | `e2798bd` | EDL exporter: same fix — REC columns were zeroed at every fractional rate |
| 12 | `0174679` | Retraction + four new evidenced `ui.js` findings (docs only) |

Iterations 1–4 were audit and instrumentation groundwork, recorded in the backlog.

**Every iteration ended green:** `build-verify` 250 passed / 7 skipped with the XSS + XXE + fail-open gates clean; `npm run test:js` exit 0; `build:renderer` 367 files, v2026.6.1. Each fix was mutation-swept, and equivalent mutants are argued as equivalent rather than counted as caught.

## What I found and deliberately did not fix

**`ui.js` — four findings, no code change (iteration 12).** `ui.js:273` holds a **fourth** private `tcToFrames`, and it returns `0` rather than `NaN` on a non-match. That makes the `Number.isFinite` guard at `ui.js:394` a tautology, so malformed source timecode satisfies `0 >= 0` and **the rec-duration fallback at `ui.js:397-399` is unreachable dead code**. Any event whose source timecode is absent, empty, malformed, **drop-frame** (`01:00:00;00`) or 3-part gets record duration **0**. `ui.js:273`/`:279` also carry the same fractional-rate defect just fixed in `edl_export.js`, with no `safeTC` to hide it — `framesToTC(120, 23.976)` reaches the UI as `"00:00:05:0.12000000000000455"` verbatim. `normalizeFpsNominal` exists at `ui.js:294` but the call sites at `:6344` and `:19205` bypass it.

Not fixed because: the functions are private to `ui.js` and unreachable from `tests-js/`, so a fix would ship untested; `ui.js` is already dirty with 32 lines of your work; and `node` cannot load `ui.js` at all, so a broken edit produces a **green build and a broken app**. About an hour remained on the clock — this was a verifiability decision, not a time one. A probe reproducing the defect in isolation is at `/tmp/probe12b.mjs`.

**Also open:** `fcpxml.js:336` and `prproj.js:465` are the third and fifth private timecode readings, both read-side. Converging all five is the natural next piece of work.

**Retracted:** iteration 11 logged "`utils_time.tcToFrames` returns `NaN` for short input" as a bug. It is not — the `NaN` is load-bearing across ~20 `Number.isFinite` guards that use it to mean *"unusable, skip / try the next strategy."* Removing it would turn twenty loud skips into twenty silent wrong numbers. The retraction is committed.

## Repository hygiene worth knowing

- **`npm run test:js` is green in your working tree but red at HEAD.** 10 suites fail from a clean checkout with `ERR_MODULE_NOT_FOUND` — `aeScript`, `cameraIdt`, `conformWiring`, `dynamicRamp`, `exrJobMetadata`, `frameMap`, `imfDirectEngineRealtime`, `pfxTransportDom`, `securityGates`, `vfxPullCore`. They import files that are **untracked**, chiefly `src/scripts/features/aceslook/services/ocfIdtResolver.js` and `tools/scan-innerhtml.mjs`. I verified this by materialising the pure HEAD tree with `git archive` and running the identical sweep: the same 10 fail there, so it's pre-existing and not something the loop introduced. Committing those files fixes it. (`imfDirectEngineRealtime` additionally has 5 real assertion failures.)
- **`tests-js/timecodeFuzz.test.mjs` and `electron/native/seekModel.js` are an untracked pair.** I extended the fuzz suite in iteration 10 and deliberately did **not** commit it: it imports `seekModel.js`, which is also untracked, so committing it alone would break `npm run test:js` for everyone. They need to land together.
- **45 files in `tests-js/` carry a foreign `644 → 755` mode flip**, some untouched since June. Where I committed such a file I staged content only and held the index mode at 644 (`git update-index --chmod=-x`); the worktree stays dirty. This is a property of your tree, not of the loop.
- **~690 pre-existing dirty files were left untouched throughout,** per your instruction.

## Method notes — four lessons worth keeping

1. **A wrapper that defends itself against its own callee hides the callee's defect from every other caller.** Five instances this run: `timecodeToFrames` rounding fps before calling down, `xml.js::normFps`, `ui.js::normalizeFpsNominal`, and two more. Each looks like diligence, because the defence and the documentation are the same three lines.
2. **A sanitizer can conceal the defect it catches.** `safeTC` turned a timecode any CMX3600 reader would reject *loudly* into a `00:00:00:00` every reader accepts *silently*. Without it, the EDL bug would have been reported years ago.
3. **A sentinel that passes the caller's validity check is worse than a value that fails it.** `ui.js`'s parser returning `0` instead of `NaN` is exactly what killed its own fallback chain.
4. **A green suite tells you the assertions passed, not that they ran against the thing their names claim.** Four times this run a mutation survived every new test. The sharpest case: a *property* test — `tcToFrames(framesToTC(f)) === f` — holds for any self-consistent base, so flooring 23.976 to 23 round-trips perfectly. Invertibility cannot distinguish base 24 from base 23; only a known absolute frame count can.

## Packaging — done once, at the end, and verified

`npm run build:mac-dir` at 07:07, exit 0. `dist/mac-arm64/PostFlowX.app` rebuilt. The sealed `dist/desktop/scripts/modules/edl_export.js` extracted from `app.asar` is **byte-identical to the worktree source** and contains both the fix (3 `nominalBase` references) and your `FCM: DROP FRAME` line — so the EDL fix and your drop-frame work are both live in the packaged app.

Two side effects on tracked files, left uncommitted for you to judge:

- **The universal Swift build is no longer broken on this machine.** `build:avf` ran the full arm64 + x86_64 + `lipo` path and succeeded. `electron/native/avf_bridge` went from 288,872 bytes (arm64-only, what's at HEAD) to 571,504 bytes; `lipo -archs` reports `x86_64 arm64`, and the copy sealed into `app.asar.unpacked` is identical (`shasum 95419ec…`). The June 2026 report's note that the universal build is broken here is now out of date.
- `electron/native/avf_bridge_arm64` shows as deleted, which is just the `build:avf` script's own `rm` of its intermediates — the script creates and removes that file on every run, so the end state is the same either way.

Two unrelated build-environment notes from the log, neither an error: the optional Metal HTJ2K decoder was skipped (`brew install openjph` to enable it), and `GOOGLE_DESKTOP_CLIENT_ID` was unset so Google login is disabled in this build. Code signing was skipped, as expected for `build:mac-dir`.

## Suggested first moves

1. Confirm your drop-frame work in `src/scripts/modules/edl_export.js` is intact (item 2 above) before `/tmp` clears.
2. Decide what to do about `6e14ec6` (item 1). Tag `loop-history-backup` → `4ef5a86` if you want to rewind.
3. Commit `ocfIdtResolver.js` + `tools/scan-innerhtml.mjs`, and the `timecodeFuzz.test.mjs` + `seekModel.js` pair, so `npm run test:js` passes from a clean clone.
4. The `ui.js` extraction pass — lift `durFramesFor` into `src/scripts/modules/` as an exported helper, point `ui.js` at it, test it directly, and converge `ui.js:273`/`:279` onto `nominalBase`. Largest known remaining defect, and the one thing this loop found but could not safely fix.

---
---

# PostFlowX — Morning Report (2026-06-27)

Concise summary of the session. Detail in `PostFlowX_Nightly_Backlog.md` (12 progress entries) and `PostFlowX_Audit_Report.md`.

## Headline
Started from an OCF-preview bug + an empty roadmap log; ended with the **Night-1 inventory done**, a **critical preview bug fixed**, **2 security vulnerabilities closed**, and **3 roadmap features advanced** — all verified, sealed in the arm64 build, and logged. Remaining high-value work needs a live app (running UI + media + Resolve).

## Done & verified
| Area | What | Verification |
|---|---|---|
| **Bug (critical)** | Desktop `chrome.runtime.sendMessage` shim returned `undefined` → OCF preview companion tiers never received responses. Now returns a Promise (MV3). | sealed in asar |
| OCF (D3) | Real error stages (`render_timeout`/`companion_down`/`companion_error`) + JSON logs (were `[object Object]`) | sealed |
| **Security** | **XXE** — `safe_xml` guard across all 6 companion XML parse sites | pytest 126; attacks blocked |
| **Security** | **Path traversal (write)** — `shotName`/`outputPattern` confinement in EXR/AMF delivery | 6 tests; suite 132 |
| **Security** | **DOM XSS** — 7 unescaped `innerHTML` sinks fixed (prep_mark, ui, imf_ui, markerProxySettings) | escaping unit-tested |
| Feature (D2) | Shareable `.pfxpreset` import/export + bundled 6-preset starter library | 59 tests |
| Feature (D1) | Watch-folder **brain** complete: classify + settle/debounce + orchestration | 63 tests |
| Tests (E1/E2) | `npm run build-verify` gate (caught a pre-existing red); golden tests for live `fdlGenerator` | 43 JS files + pytest 132 |
| UI | De-colored all tabs (muted palette), balanced top bar, removed shot-list dropzone | shipped |

**Build state:** `npm run build-verify` green (node 0 fail · 43 JS test files · **pytest 132**). arm64 `.app` repackaged and verified sealed after each shipped change. Native build = arm64-only path (universal Swift build is broken on this machine — see [[postflowx-arm64-build]]).

## Roadmap status (per Night-1 inventory)
- **A (IMF Validation)** ~95% — full; XXE now hardened.
- **B (VFX Pull)** ~90% — probe/conform/EXR/manifest all WORK; OCF preview transport fixed, **not yet live-verified**; batch-render perf open.
- **C (Playback routing)** ~50% — **the biggest gap**: frame-accurate seek/step/thumbnail parity is missing/inconsistent across AVF vs mpv.
- **D (Automation)** ~85% — D3/D4 work; D2 done; D1 brain done (wiring left).
- **E (Build/Audit)** ~85% — build-verify + tests + 3-area audit done.

## Blocked on a live session (the real remaining value)
1. **OCF preview** — confirm the preload fix renders frames end-to-end (needs OCF drive mounted + Resolve connected); if slow, do the batch-render perf fix.
2. **C2 playback parity** — design + implement one frame-accurate seek/step/thumbnail API; needs real media.
3. **D1 wiring** — ~20-line Electron `fs.watch` adapter + one-click prompt; brain is built/tested, sketch in `watchController.js` header.

## Suggested next (live)
Open the app with media loaded + Resolve connected, report what the OCF preview shows, and resume on **B (OCF verify)** or **C2 (playback parity)** — that's where the roadmap distance now is.

## Open follow-ups (headless, low priority)
- Consolidate prep_mark's two HTML-escape helpers (`_escHtml` + `_pmEscHtml`).
- Mechanical sweep of remaining ~570 `innerHTML` sinks + a lint rule banning bare-`${}` `innerHTML`.
- Confirm a restrictive renderer CSP (`script-src 'self'`) to blunt the XSS class wholesale.
- Scope `pfx:readFile`/`pfx:writeFile` to known roots.

---

# Closing report — the 15:00 run (2026-07-26, 08:23 → 14:30)

A second autonomous RESEARCH → CODE → AUDIT loop, run to the 15:00 stop. Five iterations (13–17), **ten commits**, one theme.

## The theme: one field was doing two jobs

Every fix in this run descends from a single observation made in iteration 13 and only fully understood in 15: the codebase used one number, `fps`, for two incompatible things.

- **Timecode base** — a whole-frame count. 24 on a 23.976 show, 30 on a 29.97 one. Timecode arithmetic counts *fields* and needs this.
- **Exact playback rate** — 23.976023976…. Anything touching real media time (a seek, a duration in seconds, an AE comp rate) needs this.

They differ by 0.1%: **3.6 seconds — about 86 frames — at the one-hour mark.** Whichever one you store in a field called `fps`, half the consumers are wrong, and which half changes per parser. That is why the same defect kept reappearing in different clothes.

| It. | Commits | What landed |
|---|---|---|
| 13 | `64b2848`, `f29812d` | Event duration: a dead fallback chain, and fractional-rate timecode. Survey of all 17 parsers. |
| 14 | `7372184`, `1feb2f6`, `347d276`, `0389cdf` | Reviews marker source TC malformed at every fractional rate; cutdiff VFX pull lengths fractional; FCPXML rational times resolved at the rounded rate. |
| 15 | `7791423`, `ef24ad5` | **The contract.** Six parsers split into `fps` (base) + `fpsExact` (true rate); `nominalBase()` added to `utils_time.js`. |
| 16 | `580acb0`, `a2bb645` | The consumer side: the visual conform engine now seeks the reference on the playback rate. |
| 17 | *(docs only)* | Survey — retired three carried backlog items as dead code or stale paths. |

## The one thing to read if you read nothing else

Iteration 15's parser fix made `state.fps` the whole base everywhere. That was correct, and it **made the visual conform engine worse**: before it, the XMEML path reported 23.976, so those seeks were right by accident and the timecode maths was wrong. After it, the maths was right and the seeks were consistently wrong on every NTSC show. Iteration 16 closed that. It is recorded in the commit message and in both markdown docs as a regression I introduced, not a defect I found, because the two iterations only make sense read together.

The severity there is not evenly spread, and that matters more than the size of the error:

1. The master search self-corrects — its ±30 s window swallows 3.6 s.
2. The **reference** seek has no window at all. A rate error there does not weaken a match; it hashes a *different shot* and matches that one with full confidence.
3. `unmrefSec >= refDuration - 0.1` turns the overshoot into a **silent drop** — an event near the tail of a long reference leaves the conform with no row and no error.

## What a green build did and did not prove

`build-verify` was green at the end of every iteration (250 pytest passed / 7 skipped) and `build:renderer` produced 368 files each time. But `grep -rln "trlconf" test/ tests-js/` matches one file, in two *comments*. **No test imports the visual conform engine.** Its rate fix is backed by reasoning and a diff, by no machine. That is the highest-value open item in the backlog, above any remaining fix.

## Working-tree discipline

The tree carries roughly 690 pre-existing dirty files of in-flight work. Every commit in this run contains only the files that iteration touched, and only the hunks it wrote. `trlconf/index.js` needed a different technique to achieve that — it has 155 hunks against HEAD and 5 of the 24 I needed came back merged with the user's adjacent work, so the staged content was reconstructed from HEAD and written with `git hash-object` / `git update-index` without the working tree ever being touched. Your uncommitted work is exactly where you left it. Two near-misses during that process are written up in the audit report; both came from reconstructing target text from memory instead of reading HEAD's bytes.

## Artefact

`npm run build:renderer` + `npm run build:mac-dir`, exit 0, at **14:19** — `dist/mac-arm64/PostFlowX.app`. Unsigned local package, built from the working tree, so it contains your in-flight work as well as the committed fixes. Iteration 17 changed no source, so this is the final build of the run.

## Where to pick up

1. **A test that imports `trlconf/index.js`.** Extracting its frames↔seconds helpers into something importable is worth more than any further fix inside it.
2. **`_refineSourceOut`** — once it lands in HEAD. Its ±0.9 s / ±1.2 s windows are far narrower than 3.6 s, so on NTSC it does not degrade, it **silently no-ops**, under a doc comment promising it "can only improve accuracy, never regress it."
3. **`modules/amf_convert.js`** — three private TC helpers plus `framesToSec` and the `ensureComp` comp rate. It generates ExtendScript and cannot import `nominalBase`, so both rates have to be threaded in through `JOB`.

Full detail: `PostFlowX_Nightly_Backlog.md` (what was done) and `PostFlowX_Audit_Report.md` (what was found, and the heuristics the loop accumulated).
