# PostFlowX — Security / Correctness Audit Report

Rotating audit per the nightly working agreement (Epic E_rolling). One area per pass.

---

## 2026-06-27 — Area: Electron IPC / preload boundary + main-process subprocess & path handling

Scope: `electron/ipc.js`, `electron/preload.js`, `electron/main.js`, companion subprocess/XML. Goal: path traversal, command injection, unvalidated renderer→main paths, XML XXE, and the DOM-XSS sinks those primitives elevate.

### Summary
| Severity | Finding | Status |
|---|---|---|
| — (safe) | No shell injection anywhere (`shell:true`/`os.system`/`shell=True` absent; `.exec(` hits are all regex) | ✔ verified clean |
| — (safe) | `pfx:deleteProject` path-confined (`resolve`+relative-check+manifest gate+`trashItem`, not `rm`) | ✔ well-hardened |
| — (safe) | `pfx:openExternal` allows only `http(s)://` | ✔ ok |
| Low (by design) | `pfx:readFile` / `pfx:writeFile` / `pfx:saveFile` are **unconfined arbitrary-path** R/W | accepted — desktop capability; documented as impact-multiplier |
| Resolved | Companion XML parsing was XXE-vulnerable (`ET.fromstring`/`ET.parse`) | ✅ fixed earlier today via `safe_xml` (all 6 files) |
| **Medium** | **Inconsistent HTML-escaping** — untrusted strings (error messages, file paths) interpolated into `innerHTML` unescaped in some sinks | ⚠ partially fixed (see below) |

### Medium finding — DOM XSS via unescaped `innerHTML` interpolation
**Chain:** macOS filenames may contain `<>"'&`. A maliciously-named OCF file (or a companion/decoder error echoing such a path) reaches an `innerHTML` sink that interpolates the string without escaping → arbitrary script in the renderer. Because the IPC surface exposes **unconfined `pfx:readFile`/`pfx:writeFile`**, renderer script execution escalates to arbitrary local file read/write (exfiltration / tampering). Hence Medium, not Low.

**Good news:** an escaping discipline already exists and is used widely — `_esc()` / `escapeHtml()` in `aceslook`, `mediaSearch`, `imf_ui`, `visualQcModal`, `vfxPullPanel` (thumbs), etc. The gap is *inconsistency*: a subset of error/label sinks skip it.

**Confirmed unescaped sinks (file/error-derived input):**
- `prep_mark.js` — OCF strip error cell: `title="${r.error}"...${stageLabel}` ✅ FIXED (`_escHtml`)
- `prep_mark.js` — OCF drop-zone relink error: `Error: ${err.message}` ✅ FIXED
- `prep_mark.js` — OCF error pane: ` Stage: ${r.stage}.` ✅ FIXED (defense-in-depth)
- `ui.js:3690` — ACES Look load error `${err.message}` ✅ FIXED (`escapeHtml`; low — JS load error, defense-in-depth)
- `cutdiff/index.js:4165` — triaged ✔ SAFE: `ensureRow` only ever called with **hardcoded literals** (`'cutdiffDiffTlTrackOldAudio','OLD A'`). No untrusted input.
- `vfxPullPanel.js:355` — triaged ✔ SAFE: `_wsRenderFallbackOrError` `label` is always `'OCF'`/`'QT REF'` and `msg` resolves to fixed strings (raw `e.message` is only used in `.includes()`, never interpolated).

**Fix applied this pass:** added `_escHtml()` to `prep_mark.js` and wrapped the three file/error-derived OCF sinks above. Escaping contract locked by `tests-js/escHtml.test.mjs` (8 assertions incl. `<img onerror>`, attribute-breakout, malicious path). `build-verify` green.

**Renderer-wide sweep (2nd pass, same day):** grepped all `src/scripts/` `innerHTML` sinks for untrusted-var interpolation NOT already wrapped in an escape helper. The codebase is largely disciplined (`esc`/`esc2`/`_esc`/`_xesc`/`_pmEscHtml`/`escapeHtml` in wide use). Additional unescaped file/error-derived sinks found + fixed:
- `imf_ui.js:1723/1731` — `_labelQc.error` (+ `metaBits` lines) from IAB ADM parsing ✅ FIXED (`_esc`)
- `core/markerProxySettings.js:34` — media-root `title="${r.path}"` + `${r.label||r.path}` (raw file paths) ✅ FIXED (added local `_esc`)
Confirmed SAFE (literals/app-constants, no fix): `cutdiff/index.js:4165`, `vfxPullPanel.js:355`, `prep_mark.js:15224` (color palette names).

**Recommended follow-ups (Epic E):**
1. ✅ done — every flagged + swept untrusted sink escaped (prep_mark ×3, ui.js ×1, imf_ui ×2, markerProxySettings ×1); remainder confirmed literal-only.
2. Minor tidy: `prep_mark.js` now has two escape helpers (`_escHtml` top-of-file + pre-existing `_pmEscHtml` @16340) — consolidate to one.
3. ✅ done — built `tools/scan-innerhtml.mjs` (`npm run scan:xss`): heuristic scanner listing `innerHTML` interpolations not wrapped in a known escaper. It **found a sink manual grep missed** — `aceslook/cards/SourceDetectionCard.js:15` interpolated the dropped **file name** (`state.source.name`) unescaped → ✅ FIXED (8th sink). Remaining ~313 candidates spot-checked as safe-by-construction (composed `_esc`-wrapped table fragments, numeric/version labels, app-constant ternaries). Tool is a review aid, not a hard gate (would false-positive on safe composed fragments).
3. Defense-in-depth: scope `pfx:readFile`/`pfx:writeFile` to known roots (project folder / media root / cache) where feasible, or require an allowlisted prefix.
4. Confirm a restrictive CSP on the renderer (`script-src 'self'`) — would blunt the whole XSS class even where escaping is missed.

---

## 2026-06-27 (2nd area) — Archive extraction & path traversal (write paths)

| Severity | Finding | Status |
|---|---|---|
| — (safe) | No archive extraction-to-disk anywhere — JS `lib/zip.js` reads entries **into memory** (`unzipOne`/`unzip`); companion has no `zipfile`/`tarfile`/`extractall`. Zip-slip not a vector. | ✔ verified clean |
| **Medium** | **Path traversal on WRITE** in companion EXR/AMF delivery + render: `shotName` (editorial/EDL-derived) and `outputPattern` (renderer-supplied) flowed into `os.path.join(output_dir, …)` unsanitized → a crafted `../` name writes outside the chosen output dir. | ✅ FIXED |

**Fix:** added `_safe_name_component` (neutralizes `/` `\` `..`), `_confined_join` (realpath+commonpath confinement under the output dir — catches `../`, absolute, symlink escapes), and `_safe_output_pattern` (rejects separator/traversal patterns → safe default). Applied in `_ocf_copy_exr_delivery` (shotName sanitized + confined; AMF filename uses the safe segment) and at both write-path `outputPattern` reads (`api.py:2354`, `:3796`). A blocked shot returns a clean per-shot error, not a crash. Tests: `companion/tests/test_path_confinement.py` (6 assertions: legit-pass, `..`/abs/separator rejection). Companion suite 126→**132 passed**. Shipped (companion = extraResources, verified in bundle).

---

## 2026-06-27 (3rd area) — Companion IPC input validation (read / delete / copy paths)

Reviewed every companion handler that reads, deletes, or copies a path, asking: is any **renderer-supplied** path used to return file contents (arbitrary read / exfiltration) or to delete/overwrite arbitrary locations?

| Check | Result |
|---|---|
| File read → data-URL return (`_file_to_data_url`, still/thumb extracts) | ✔ all read **internally-generated** cache/temp/render-output paths (`cache_dir/{cache_key}.fmt`, `tmp.name`, `found_path`) — never a raw renderer path |
| `unlink`/`rmtree` operations (api.py, proxy_service.py) | ✔ operate on **internal job-state** paths (companion-created outputs) or suffix-filtered cache entries — not raw renderer input |
| Copy SOURCES (`exrFolder`, `amfPath` in delivery) | accepted — user-initiated first-party reads into the now-confined delivery dir; not an escalation |

**Conclusion: clean.** No arbitrary read-and-return or arbitrary-delete primitive is exposed; the renderer-controlled **write** path (fixed in area 2) was the real exposure. Negative result recorded for audit trail.

---

## 2026-06-27 (4th area) — Companion localhost HTTP media server (`http_server.py`)

A localhost HTTP server (default :47125) serves media frames/proxies to the renderer — a real attack surface. Reviewed bind, auth, path handling, CORS.

| Check | Result |
|---|---|
| Bind address | ✔ **127.0.0.1** in both modes (api.py `ensure_http_server` default + app.py `--host` default) — no LAN exposure |
| Auth | ✔ random per-run token (`secrets.token_hex(24)`), **constant-time** `compare_digest`, via `X-PFX-Token` header or `?token=` |
| Token-exempt routes | ✔ `/ping`+`/health` return status only; `/file/{assetId}` is a **capability URL** — unguessable per-session UUID, only companion-registered files, localhost-bound |
| Path traversal | ✔ every served name rejects `"/" "\\" ".."`; `_safe_proxy_stem` sanitizes proxy names |
| CORS `*` | acceptable — content is still token/capability-gated; `*` only enables the renderer's cross-origin `fetch` |

**Conclusion: clean / well-hardened.** Note (informational, not a vuln): `/file/{assetId}` security rests on UUID unguessability + localhost — fine as a capability design; just don't log/leak those URLs externally.

**Audit scorecard (4 areas):** IPC/preload+XSS → 2 fixed (XXE + 8 sinks); path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean. Plus `npm run scan:xss` regression tool.

### Method notes
- `ipcMain.handle` surface enumerated (44 handlers); destructive/path ones reviewed by hand.
- Subprocess grep across `electron/` + `companion/src` for shell-exec patterns → none.
- `innerHTML` interpolation grep across `src/scripts/` → 575 sinks; high-risk (filename/error/clip/tc) subset reviewed.

---

## 2026-07-26 (5th area) — Test/verification integrity: does `build-verify` actually verify?

Rotating area chosen deliberately: every prior entry in this report and in the nightly backlog rests on the sentence "`build-verify` green". That claim had never itself been audited. It should have been — it was false.

| Check | Result |
|---|---|
| `build-verify` runs the JS suites | ✔ `test:node` + `test:js` genuinely execute and fail loudly |
| `build-verify` runs the Python suite | ✘ **HIGH — fails open.** `(cd companion && python3 -m pytest -q)` → `No module named pytest`. No pytest in the macOS CLT python3, none in Homebrew python3.14, no `.venv` in the tree, no `pytest` binary on PATH. The 250-test companion suite **never ran**, and the gate still reported a pass |
| Security gates (`scan-innerhtml`, `scan-rawxml`) | ✔ both execute and gate correctly |
| Coverage of the IAB/S-ADM parser | ✘ **MEDIUM.** Its only test file is `skipif`-gated on a hundreds-of-MB Meridian MXF present on one workstation. Effectively 0 coverage of a parser that consumes untrusted package XML |

**Impact.** This is a meta-vulnerability, not a code one, and it is the more dangerous kind: it silently invalidated the verification evidence behind every hardening claim in this report. The XXE work in particular ("companion pytest 126/126 pass") was being re-asserted by a gate that had stopped running those tests. The fixes were real — re-running the suite properly now yields 250 passed / 7 skipped — but the *evidence* was not.

**Fixed.** `tools/run-pytest.mjs` resolves an interpreter (`companion/.venv` → `$PFX_PYTHON` → PATH), verifies `import pytest` succeeds *before* running, and exits 1 with the venv-creation command otherwise. A missing interpreter is now a red gate, not a green one. Wired into `test:py` / `build-verify` / `test`.

**Also fixed (correctness, found while closing the coverage gap).** `_parse_adm_xml`'s Resolve-style `tracks` list was built from the **deduped** `object_names` while the summary was count-driven. An IAB package whose objects carry no `audioObjectName` attribute rendered a bed-only track view against a summary correctly reporting 49 objects; duplicate-named objects collapsed to one row. Both are silent wrong-output, not crashes — exactly the class that reaches a delivery. Now count-driven with document-order labels and `Object N` synthesis. 14 tests, mutation-verified.

**Generalizable lesson for future passes:** *audit the gate before trusting the gate.* Any check that can be absent rather than failing — an optional interpreter, a `skipif` fixture, an optional linter, a `|| true` — should be treated as not running until proven otherwise. Two of the five checks in this project's gate were in that category.

**Audit scorecard (5 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; **verification integrity → 1 high (gate fails open) + 1 medium (fixture-gated coverage), both fixed**, plus 1 correctness bug fixed in passing.

## 2026-07-26 (6th area) — Fail-open verification, part 2: the JS suite, and structural prevention

The 5th-area audit ended with a lesson rather than a rule: *audit the gate before trusting the gate.* This pass tests whether that lesson generalises past the one instance that produced it. It does.

| Check | Result |
|---|---|
| `test:js` fails loudly on a hand-rolled test failure | ✔ `process.exit(failed ? 1 : 0)` at the foot of each file, and `test:js` loops with `\|\| exit 1` |
| `test:js` fails loudly on a `node:test`-style file | ✔ verified empirically — both `test()` and `describe`/`it` forms exit 1 when run directly under plain `node` |
| Test files fail loudly when a **first-party** module won't load | ✘ **MEDIUM — fails open.** 4 files swallowed any `require()` error on `electron/imf/imf_direct_engine.js` and exited 0 |
| Any npm script neutralises its own exit code (`\|\| true`) | ✔ none |
| The class is structurally prevented from returning | ✘ nothing stopped it → **now gated** |

**Impact.** Same shape as the pytest hole, one layer up: a broken *subject under test* deleting its own tests. `imf_direct_engine.js` is first-party, so its absence is never a legitimate skip condition — but the catch could not tell "engine has a syntax error" from "optional dependency missing" and resolved both to success. 76 assertions covering the realtime engine, progress/cancel, MJPEG reassembly, and the preload↔engine poll contract would have vanished from a green run. This was latent (all four pass today), which is precisely why it survived: a fail-open check is invisible until the day it matters.

**Fixed.** All four catches now print `FAIL - imf_direct_engine failed to load` with the stack and `process.exit(1)`.

**Prevented.** `tools/scan-failopen.mjs --gate`, wired into `build-verify` alongside the XSS and XXE gates. It fails the build on a `catch` that exits 0, a `catch` that logs `SKIP` and bare-returns, or an npm script that discards its exit code. Real optional dependencies remain expressible with `// fail-open-ok: <reason>`, which makes each surviving skip an explicit, greppable, reviewed decision instead of an accident. Mutation-verified against the exact pre-fix source; 13 predicate assertions added to `tests-js/securityGates.test.mjs`.

Worth recording: the gate's own meta-tests exposed a flaw in the gate. The first cut folded the two lines preceding a `catch` into its body so an annotation above the block would count — which meant a preceding catch's `process.exit(0)` leaked into the next catch's verdict. Caught by a two-catch fixture asserting *exactly one* finding. The annotation is now carried as a separate field. A gate that isn't itself unit-tested is just another unaudited check.

**Audit scorecard (6 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium, both fixed, plus 1 correctness bug; **verification integrity (JS) → 1 medium fixed + 1 structural gate added.** Three of this project's now-six build gates were, at some point, capable of passing without running. That ratio is the finding.

## 2026-07-26 (7th area) — Engine routing: a decision made correctly, then discarded

Scope: the codec→engine decision on both sides of the app — `companion/.../media_engine/media_router.py::select_engine` and `src/scripts/core/playbackRouter.js`, plus every consumer of their return values.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | `playableMedia.js` dispatched the router's engine with an `if/else if/else` chain covering only `NativeAVPlayerEngine` and `MPVPlayerEngine`. `PFXNativeEngine` — the preferred ProRes engine, returned on *every* desktop build — fell into the `else` and was sent to the Chromium player the same return had flagged `htmlVideoBlocked: true`. | Fixed |
| 2 | Medium | Consequence of #1 in the proxy-reuse branch: a ProRes clip with a cached proxy commits to the transcoded proxy and returns before the black-frame recovery can run, so the native path is never reached. | Fixed via #1 |
| 3 | Medium | `tests-js/playbackRouter.test.mjs` had 20 assertions, all against `selectPlaybackEngine` — a function with no production callers. The async `selectEngine` that the app actually runs was untested. | Fixed |
| 4 | Low | `window.pfxPlatform?.nativeEngine` was used as a capability check, but preload exposes it as an unconditional object literal — the check can never be false, making the `avf_bridge` and MPV fallback rungs unreachable by construction. | Fixed (now reads `isReady`) |
| 5 | Info | Backlog item C1's premise ("routing split between the companion and `smart_router.js`") is false — `smart_router.js` is a pure HTTP proxy with no decision logic. Seventh stale/incorrect backlog entry. | Recorded |

**Impact.** Every ProRes `.mov` opened on macOS paid a wasted Chromium decode plus a ≥2.5 s black-frame timeout before the canvas engine rescued it; with a cached proxy present, the full-quality native path was never reached at all. The `~5ms/frame` engine the router advertises as preferred was, in the shipped app, only ever reached by a timing heuristic — never by the decision that named it.

**Prevented.** Routing now goes through one exhaustive `pathForEngine()` map; an `ENGINE` constant added without a route fails `tests-js/playbackRouter.test.mjs` rather than silently becoming Chromium, and a source-level assertion blocks reintroducing a hand-written `=== ENGINE.*` chain in the consumer. Both mutation-verified.

**The pattern this shares with areas 5 and 6.** Iterations 1 and 2 found checks that reported success without running. This one is the same shape one layer out: a decision computed correctly, discarded by its consumer, and *masked by a fallback that made the outcome look right*. The black-frame timeout is exactly the kind of resilience that hides the defect it compensates for — the app was never wrong on screen, only slow, so nothing ever surfaced. Fallbacks should be instrumented, not just installed; the natural follow-up is C-RT2, a HUD naming the backend that served each frame, which would have made this visible on the first ProRes open.

**Audit scorecard (7 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; **engine routing → 1 high + 2 medium + 1 low, all fixed.** Four of the seven areas turned up a defect whose defining feature was that it produced no visible symptom.

## 2026-07-26 (8th area) — JPEG 2000 decoder routing: one question, three answers

Scope: every place that decides HTJ2K (Part 15) vs classic (Part 1) and picks a decoder — `src/sandbox/j2k_decoder.js`, `src/scripts/modules/imf/imf_j2k.js`, `src/scripts/modules/imf/imf_player.js` — plus the per-frame call path from the IMF player.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | `imf_j2k.js::decodeHTJ2K` performed no codestream classification. On desktop it sent **every** J2K frame to OpenJPH, an HT-only decoder, so classic Part 1 IMF essence paid a full copy into the WASM heap plus a thrown exception *per frame* before falling through to the sandbox. Nothing disables the direct path after a failure, so the cost repeats for the whole clip. | Fixed |
| 2 | Medium | The same function accepted `0xFF50` as an alternative SOC, documented as the "HTJ2K SOC". No such marker exists — `0xFF50` is CAP and cannot appear at offset 0. Dead branch built on a wrong premise. | Fixed |
| 3 | Medium | Three independent parses of the same header. Only the sandbox's tested the capability bit; `imf_player.js::parseJ2KHeader` extracted `rsiz` correctly and used it for display only. | Fixed (two converged; the third is queued) |
| 4 | Medium | No decode-route instrumentation anywhere. Nothing recorded which backend served a frame or how many direct attempts were thrown away, which is why #1 was invisible. | Fixed (`getDecodeRouteStats`) |
| 5 | Low | The new test suite initially built its HT fixtures from the constant under test, so a wrong-capability-bit mutation passed. Caught by mutation testing, not by review. | Fixed (literal fixtures) |

**Impact.** Silent, unbounded, per-frame waste on the most common IMF profile, on the one platform where the fast path is enabled. As in area 7, the *output* was always correct — the sandbox rescued every frame — so the only symptom was slowness and a repeating `console.warn` that reads like routine fallback chatter rather than a routing bug.

**Prevented.** One exported classifier, imported by both consumers, with source-level assertions that neither re-derives it and that the sandbox no longer defines its own copy. Unreadable headers resolve to classic, never HT — the asymmetry is deliberate: the classic rung has a pure-JS fallback behind it and the HT rung has nothing, so the conservative answer is the safe one. Four mutations verified.

**The pattern, now stated in general form.** Area 7 was *a decision made correctly and discarded by its consumer*. This is the next step out: **the same decision derived independently in N places will disagree, and the copy that's wrong is the one nobody tested.** The sandbox's sniff was right and unit-testable; the copy on the hot path had never been isolated from WASM and so had never been tested at all. Convergence on a single exported predicate is what makes the question testable exactly once. Finding #5 is the same disease inside the cure — a fixture derived from the value it validates is another copy that agrees with itself.

**Audit scorecard (8 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; **J2K decoder routing → 1 high + 3 medium + 1 low, all fixed.** Five of the eight areas turned up a defect with no visible symptom, and in three of those the thing that hid it was a fallback doing its job.

---

## 2026-07-26 (9th area) — Decode-route observability: instrumentation nobody reads

Scope: the operator HUD in `imf_player.js` and the route counters added in area 8.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | `getDecodeRouteStats()` was exported by `imf_j2k.js` and called from nowhere. The counters that would have made area 8's routing bug visible were themselves invisible — the fix shipped its own blind spot. | Fixed |
| 2 | Medium | The real-time HUD reported fps, scale, drops and decode-ms but never named the decoder. The four rungs of the ladder — direct OpenJPH, sandbox HT, sandbox OpenJPEG, pure-JS baseline — are visually identical, so a clip silently running on the JS baseline looked like a clip that was merely slow. | Fixed |
| 3 | Medium | The HUD painted itself green on cadence alone. A reel holding 24 fps on the pure-JS fallback decoder was reported as healthy. | Fixed (`route.degraded` outranks `cadenceOk`) |
| 4 | Low | Route counters were process-lifetime cumulative while every adjacent counter (`droppedFrames`, `lastFrameAdvance`) reset per reel, so the previous reel's backend could colour the current one. | Fixed (reset on reel load) |

**Impact.** Diagnostic only — no wrong pixels. But the whole justification for area 8's counters was that a fallback doing its job hides the defect behind it, and a counter with no readout hides it just as well. The QC-relevant case is #2: when the WASM OpenJPEG decoder fails, the pure-JS baseline takes over and produces correct frames far more slowly. On screen that is indistinguishable from a heavy reel.

**Prevented.** The summariser is a pure function over the stats object, unit-tested from both sides of its one threshold, and the player's use of it is asserted at source level — bound, computed, pushed into the HUD line, and consulted for the fill colour. A future edit that computes the route and forgets to render it fails the suite, which is exactly the failure this area was opened to fix.

**The pattern.** Areas 7 and 8 were *a correct value discarded by its consumer*. This one is the degenerate case: **a correct value with no consumer at all.** Instrumentation is not complete when the counter increments; it is complete when a human can act on it without a debugger. Worth noting that the gap was introduced by the previous iteration and found by the next one — the audit loop caught its own work, which is the only reason it was a one-iteration gap rather than a permanent one.

**Audit scorecard (9 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; J2K decoder routing → 1 high + 3 medium + 1 low, fixed; **decode-route observability → 3 medium + 1 low, all fixed.** Six of the nine areas turned up a defect with no visible symptom. In four of those, the thing hiding it was a fallback doing its job — and in this one, the thing hiding it was the absence of anywhere to look.

---

## 2026-07-26 (10th area) — Unbounded retry on a failing fast path

Scope: the direct OpenJPH rung in `imf_j2k.js::decodeHTJ2K`, and the strike latch added to bound it.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | An HT codestream this build's OpenJPH cannot decode was retried on the direct path **every frame** for the whole reel — a full codestream copy into the WASM heap plus a thrown exception each time, always ending in the same fallthrough. Area 8's sniff closed this for classic essence and left it open for incompatible HT. | Fixed (3-strike latch) |
| 2 | Medium | The failure warned once per frame. At 24 fps that is 1,440 console entries a minute, which buries the diagnostic it is writing and, with devtools attached, costs real time on the decode thread. | Fixed (logs on the tripping call only) |
| 3 | Low | `_loadDirectHTModule()` memoises a permanent failure and resolves `null` forever, but nothing recorded that the fast path was off. The HUD showed no waste and no explanation — the rung simply never appeared. | Fixed (trips the latch, surfaced as `(HT off)`) |
| 4 | Low | `createStrikeLatch` clamped its limit with `Math.max(1, …)`. Every degenerate value already produces the identical outcome, so the guard could not change any observable behaviour. A mutation removing it passed the suite. | Fixed (clamp deleted) |

**Impact.** Performance and diagnosability, not correctness — the sandbox rescued every frame, as it has in every finding on this path. The reason this kept recurring is worth naming: the decode ladder is four rungs deep, and each rung's fallback is good enough to hide the rung above it failing. Area 8 found the misroute, area 9 found that nothing displayed it, and this one found that nothing *stopped* it.

**On not crying wolf.** A latched fast path is reported but is explicitly **not** treated as degraded. It is the mechanism that ended the waste, and the direct rung can fail for reasons local to the main-page WASM heap while the sandbox decodes at full speed. Degradation is still judged on the backend actually serving frames. Marking every latch red would have made the one signal that matters — the pure-JS baseline serving playback — indistinguishable from a reel that is completely fine.

**Prevented.** The tripping rule is an exported, dependency-free factory, so consecutive-vs-cumulative semantics are unit-tested without a DOM or a decode; the hot path's use of it is asserted at source level. Eight mutations verified.

**The pattern, and finding #4 as its second instance.** Iteration 4 recorded *a fixture derived from the value under test agrees with itself*. Finding #4 is the same disease with a different vector: **a test labelled for a mechanism it cannot distinguish from that mechanism's absence.** Both report coverage that does not exist, and neither is visible to review — only a mutation finds them. The response here was to delete the mechanism rather than write a better test for it, which is the right order of operations: if no test can tell whether the code is there, the code is not doing anything.

**Audit scorecard (10 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; J2K decoder routing → 1 high + 3 medium + 1 low, fixed; decode-route observability → 3 medium + 1 low, fixed; **unbounded fast-path retry → 2 medium + 2 low, all fixed.** Seven of the ten areas turned up a defect with no visible symptom. In five of those, a fallback doing its job was what hid it — the J2K decode ladder alone accounts for three consecutive areas, one per rung of hiding.

---

## 2026-07-26 (11th area) — Codec identification: a declaration that was true for everything

Scope: `imf_parser.js` picture-descriptor classification, its five downstream consumers, and PIC004 in `imf_validator.js`. First area of this run outside the decode path.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | `isHTJ2K = isJ2K \|\| …` — so every JPEG 2000 IMP, classic Part 1 included, was classified HTJ2K. The status bar told the operator the stream was being decoded by **OpenJPH**, which by this codebase's own routing cannot decode classic Part 1 at all. Three branches written for plain J2K (the codec string, the `imf-rt-codec-j2k` badge, `d.isJ2K ? 'JPEG 2000'`) were unreachable. | Fixed (`classifyJ2KDescriptor`) |
| 2 | Medium | PIC004 emitted the HT compatibility caveat on every J2K delivery and could never emit its `SEV.PASS` arm. A warning that fires unconditionally carries no information — worse, it teaches the operator to skim the line that will matter when it is finally true. | Fixed |
| 3 | Medium | PIC004 derived severity by substring-matching `cpl.codec`, a **display string**. Re-wording a UI label silently changed validation severity, and the match could only ever echo the parser's own (wrong) conclusion. | Fixed (reads the parsed flags) |
| 4 | Medium | `ContainerConstraintsSubDescriptor` counted as evidence of JPEG 2000. It is ST 379-2 generic-container constraints, carried by **sound** essence too, so an audio descriptor could satisfy `isJ2K` and compete via `isPicture` to be the primary *picture* descriptor. | Fixed (removed from the test) |
| 5 | Medium | `04010202.03010000` sat in the HT PictureEssenceCoding set. It is the generic JPEG 2000 coding label, which classic essence is entitled to declare — an independent second path to the same false positive as #1. | Fixed (removed, with reason recorded) |
| 6 | Medium | `picDesc` was resolved in `parseCPL`, used locally, and never returned. Five call sites read `cpl.picDesc?.…` — the status-bar decoder line, the engine's HTJ2K status suffix and limitations list, and two bitDepth/resolution backfills — and all five have read `undefined` since the field was first referenced. | Fixed (returned; ordered *after* #1) |

**Impact.** No wrong pixels — this is identification and reporting. But it is the first area in this run where the app **told the operator something false on the happy path**, with no failure, no fallback and no console warning to hint at it. Every other finding on this run needed a degraded condition to manifest. This one was wrong on every correct classic delivery, and the two surfaces it was wrong on are the two an operator consults specifically to answer "is this package what I think it is": the decoder line and the codec validation row.

**Sequencing was part of the fix, not incidental to it.** Two edits here were individually unsafe:

- Narrowing `isHTJ2K` **before** repointing `isPicture` at `isJ2K` would have removed the clause that — through the bug — was doing duty as the J2K clause, dropping any J2K descriptor with an unparsed `StoredWidth` out of primary-picture selection. A wrong label traded for a missing descriptor.
- Returning `picDesc` **before** fixing the classification would have propagated the false HTJ2K label to five new consumers in a single commit, converting one wrong readout into six.

A bug can be load-bearing. `isPicture` had been quietly depending on `isHTJ2K` being over-broad, which is what makes a wrong boolean expensive to fix long after it lands — not the boolean, the code that grew around it.

**Prevented.** The descriptor answer now lives in `j2kCodestream.js`, the same module that owns the codestream-byte answer, so the declaration and the ground truth cannot drift the way they had. `classifyJ2KDescriptor` is pure and dependency-free; 43 assertions, 8 mutations, all caught. Source-level guards pin each wiring change: the parser imports the classifier, `isHTJ2K = isJ2K ||` cannot return, `isPicture` reads `isJ2K`, `picDesc` is in the return, and the validator does not substring-match `codec`.

**On grading evidence instead of asserting it.** Two facts could not be verified from the repo: the correct Pcap bit numbering (an existing fixture at `j2kCodestream.test.mjs:52` implies bit 15 in a value nothing reads; ISO MSB-first numbering would make it `1 << 17`) and whether `0d01030c` genuinely names Part 15 in RP 224. The classifier therefore decodes **no Pcap bit** — presence of `J2KExtendedCapabilities` answers the question asked without introducing a second convention to get wrong — and keeps `0d01030c` as explicitly *weaker* evidence, reported as `htEvidence: 'pec-ul'`, with PIC004 telling the operator to confirm against the codestream. Deleting a check on a hunch is the same unfounded move as adding one. Where the spec was unavailable the honest output was a graded finding, not a confident boolean.

**The pattern.** Areas 7–10 were all *the truth computed and then hidden* — discarded by a consumer, unrendered, or masked by a fallback. This one inverts it: **a falsehood computed and then displayed prominently**, on every good delivery, by two surfaces whose entire job is to be trusted. It also supplies the run's cleanest instance of the recurring shape: a flag defined as `A || B` where `A` implies `B` is not a loose definition, it is a constant — and every branch downstream written for "B but not A" is dead code that will read as intentional to every future reviewer.

**Audit scorecard (11 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; J2K decoder routing → 1 high + 3 medium + 1 low, fixed; decode-route observability → 3 medium + 1 low, fixed; unbounded fast-path retry → 2 medium + 2 low, fixed; **codec identification → 1 high + 5 medium, all fixed.** Eight of the eleven areas turned up a defect with no visible symptom. Five were hidden by a fallback doing its job; this one needed no hiding mechanism at all — it was simply never tested, and no test in `tests-js/` had ever mentioned HTJ2K.

## 2026-07-26 (12th area) — Four parsers, one format, two of them wrong

Scope: every SIZ walk in the codebase — `j2kCodestream.js` and the two private copies in `imf_player.js` and `imf_mxf.js` that iterations 4 and 7 each deferred.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | Both private parsers reported **Xsiz as the width**. The image is `Xsiz − XOsiz`, `Ysiz − YOsiz` (ISO/IEC 15444-1 Table A.9). Correct only because IMF App#2E pins the image offset to zero — an assumption neither parser stated, tested, or would have noticed the loss of. | Fixed (shared `_readSizDims`) |
| 2 | Medium | Both accepted **`Lsiz >= 38`**. `Lsiz = 38 + 3·Csiz`, so the floor is 41 at one component; 38 is a length no conforming SIZ can have. A loose gate on a marker match only matters when the match is spurious, and `FF51` occurs in entropy-coded packet data. | Fixed (`SIZ_MIN_LSIZ = 41`) |
| 3 | Medium | Both marker walks were **unbounded, with no SOT/SOD stop**. A truncated header was walked to the end of the buffer reading entropy-coded bytes as segment lengths. Worst in `imf_mxf.js`, whose only caller is `isSuspiciousCodestream()` — the input is a codestream *already suspected of truncation*. | Fixed (delegates to the bounded walk) |
| 4 | Low (latent) | `imf_player.js` built `new DataView(bytes.buffer, bytes.byteOffset)` with **no length**, so the view spanned to the end of the underlying `ArrayBuffer` rather than the frame. Every read was hand-guarded against `bytes.length`, so nothing read out of bounds — the safety lived in five separate comparisons instead of in the view. | Fixed |
| 5 | Low (latent) | `imf_mxf.js:112` returned `new DataView(bytes.buffer)`. `readBytes()` always allocates a fresh whole buffer, so this view was already correct — a property of the current reader, not of the function's contract. | Fixed (offset and length spelled out) |
| 6 | Low | `Xsiz` above 2^31 sign-flipped to a negative width under `<< 24`. Unreachable at any real resolution; fixed because a 32-bit unsigned field read as signed is wrong regardless of whether the values that expose it occur. | Fixed (`u32` multiplies) |

**Impact.** The narrowest of the twelve areas, and worth saying so plainly: the player's copy feeds one on-screen readout, and the offset it ignored is zero in every conforming IMF App#2E package. No operator has seen a wrong number from #1. The finding that actually earns its severity is **#3 in `imf_mxf.js`** — an unbounded walk whose only caller hands it codestreams selected for being *likely truncated*, which is the precise input that makes an unbounded walk misbehave. The defect and its trigger were wired directly together.

**What the convergence buys.** Not deduplication for its own sake. Four independent implementations of one format means four places for the format to be misread and no single place to fix it — and in fact the two that had drifted from the spec were exactly the two nothing imported. The shared version is the one with tests, and it was already bounded, already stopped at SOT/SOD, and already used the right Lsiz floor **for the CAP scan**; the dimension read simply had never been written there because nobody had asked it for a size.

**On null versus zero.** `width`/`height` are `null` when SIZ was absent, short, or truncated, and the JSDoc states that null means *not known* rather than *zero*. This is the substance of finding #3 rather than a stylistic note: the failure mode of a truncated SIZ is not a crash, it is a **plausible wrong number** assembled from the fields that happened to fit, with the missing ones reading as zero — and zero is a legal `XOsiz`. Silence is the only honest output, and the one consumer that displays a size is pinned by test to check for it.

**A test that passed for the wrong reason.** Nine mutations were run; eight were caught and one survived — *drop the end-of-view bound*, at 44 passed / 0 failed. The clipped-view fixture was 12 bytes, so `Ysiz` fell outside the view, read as zero, and the mutant was rejected by the **degenerate-image** guard rather than by the bound the assertion was named for. It is exactly the failure this run documented at area 6 in a different guise: *an assertion that passes because a different guard fired is not testing what its label says.* Recut to a 16-byte clip with a non-zero origin so the mutant returns a plausible 1920 × 1080 instead of the correct 1856 × 1060; the bound now carries three assertions. The block's comment was wrong too, and was rewritten — it credited the bound with preventing reads into the neighbouring frame, which is actually a consequence of indexing the `Uint8Array` instead of using a `DataView`. **A mutation that survives is not always a missing test; sometimes it is a test whose name and mechanism have come apart.**

**Restraint recorded.** Findings #4 and #5 are marked *latent* rather than *live* because both were, on inspection, guarded — by hand in one case and by the current allocator in the other. Neither could produce a wrong result today. Calling them exploitable would have been the easier write-up and the false one.

**Audit scorecard (12 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; J2K decoder routing → 1 high + 3 medium + 1 low, fixed; decode-route observability → 3 medium + 1 low, fixed; unbounded fast-path retry → 2 medium + 2 low, fixed; codec identification → 1 high + 5 medium, fixed; **SIZ parsing → 3 medium + 3 low, all fixed.** Nine of twelve areas held a defect with no visible symptom.

## 2026-07-26 (13th area) — The ALE importer: a format the app accepts and could not read

Scope: `src/scripts/parsers/ale.js`, the Avid Log Exchange importer — live, reachable from two call sites in `ui.js`, and with **no test file in the repository**. First area this run outside the IMF/J2K stack.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | `parseTC` matched `/^(\d+):(\d+):(\d+):(\d+)$/` — colons only. NTSC **drop-frame** timecode uses `;`, and Avid's usual export is the mixed form `01:00:00;00`. All four timecode columns of a drop-frame row fail together, so `buildEventFromRow`'s no-usable-timecode guard returns null and the row is discarded. **Every row — a 29.97 DF ALE imports as an empty timeline.** | Fixed (`[:;]`) |
| 2 | ~~**High**~~ → Medium | ~~An empty parse is reported **nowhere**.~~ **Corrected 2026-07-26 — this finding was overstated; see the retraction below.** The main import path *does* report an error: `handleFiles` calls `parseFromFiles` and then `if (!parsed?.events?.length){ _parseProgressHide(); showError("No valid events."); return; }`. Only `_mbLoadFiles` (~`ui.js:17395`), the match-back modal, is genuinely silent — it `continue`s past a zero-event file with no entry in `_mbFileMeta`. | **Open** (narrowed to `_mbLoadFiles`) |
| 3 | Medium | `ffInt % 100` silently rewrote the frame field. The file's own header comment advertises `HH:MM:SS:FFFFF`; a value of `00120` came back as `20`. Wrong, plausible, unannounced. | Fixed (modulo removed) |
| 4 | Medium | DaVinci Resolve 21 subframe suffixes (`01:00:00:12.5`) were rejected outright, costing the whole row exactly as #1 did. `utils_time.js::tcToFrames` already strips them; `ale.js` did not. | Fixed (`(?:\.\d+)?`) |
| 5 | Low | `24` was hardcoded twice — `detectFPSFromHeading`'s initialiser and `parseALE`'s empty-input return — with only the latter tested. Found by a surviving mutation, not by reading. | Fixed (`DEFAULT_FPS`) |
| 6 | Low | No tests existed for this parser at all: not for delimiter detection, the Heading/Column/Data state machine, reel precedence, OCF classification, or the record-to-source mirroring immediately above the guard that was deleting rows. | Fixed (37 assertions) |

**Impact, stated precisely.** This is the first area this run where the defect is **plainly visible to an operator** — and it is visible as *nothing happening*. Every previous area involved a wrong value computed somewhere and then hidden by a fallback, a discard, or an unrendered field. Here the value is not wrong; the value is absent, along with the entire event, and the only symptom is an import that produces an empty timeline for a file the app advertises support for. Drop-frame is not an edge case in this domain — it is what 29.97 delivery runs on.

**Findings #1 and #2 are one defect wearing two coats.** A parser that rejects a valid input is an ordinary bug, found in an afternoon, because someone notices. A parser that rejects a valid input *inside a pipeline that treats "no results" as "nothing to report"* is a bug that survives indefinitely: the operator sees an empty import, assumes the file was wrong, and re-exports it. #1 is fixed. **#2 is not, and is deliberately left open** — it is a `ui.js` change with a wider blast radius than a parser fix, and with #1 repaired, an empty ALE import now genuinely means something went wrong, which makes the message worth designing rather than bolting on tonight.

**Retraction (2026-07-26, iteration 10) — finding #2 was overstated.** The next iteration began by trying to fix #2 and found that half of it is not true. I had read `parseFromFiles` ending at `if (parsed?.events?.length) break;` and concluded the zero-event case fell out of the loop unreported. It does fall out of the loop — and then `handleFiles`, the caller immediately below, checks the result and calls `showError("No valid events.")`. The main ALE import path has always reported the failure. What is genuinely silent is only `_mbLoadFiles`, the match-back modal, which `continue`s past the file and records nothing in `_mbFileMeta`.

The error message that does exist is generic — it names neither the file nor the reason, so with drop-frame broken it would have said "No valid events." for a perfectly valid ALE — and that is worth improving. But it is a wording problem in one path, not the total silence the finding claimed, and the sentence above that "**#1 was invisible because of this one**" is wrong: #1 was visible as a generic error, which is a different and much smaller failure. **The paragraph below, written before the correction, overstates the case; it is left in place rather than quietly rewritten, because the pattern that produced it matters more than the tidier version.** I traced a control-flow claim to the end of one function and stopped at the function boundary instead of following the value into its caller. Reading down to the `break` and not up to the `if` is how a two-line refutation goes unnoticed for an iteration.

**On choosing a lossy fix.** Normalising `;` to `:` and treating drop-frame as non-drop is not correct in the strict sense: `01;00;00;00` and `01:00:00:00` are different instants on a 29.97 timeline. It was still the right call, because the codebase already made it — `tcToFrames` documents "DF treated as NDF" in its signature, `xml.js` strips semicolons before calling it, `edl.js` matches `/[:;]/` and reads the frame field straight. `ale.js` was the sole dissenter, and it dissented by **discarding the data rather than counting it differently**. Inventing drop-frame-correct arithmetic in one importer would have produced a ninth reading of drop-frame in a codebase that currently has one. The convergence is the fix; a repo-wide DF decision is a separate, larger piece of work and is recorded here as such.

**Two process failures, both recurrences.** The source guard asserting the modulo was gone **fired on the comment in `ale.js` that names the modulo while explaining its removal** — the same shape iteration 8 hit and hand-narrowed. Hand-narrowing evidently does not generalise, so the guards now strip comments before matching. Separately, a mutation **survived**: `let fps = 24` → `25` in `detectFPSFromHeading`, at 35 passed / 0 failed. The suite had an assertion labelled *"the documented 24 fps default"* which tested `parseALE('')` — a path that returns early with its own hardcoded 24 and never reaches `detectFPSFromHeading`. The label described the constant; the mechanism reached one of its two copies. This is the third instance this run of the same lesson, now stated in its general form: **a green suite tells you the assertions passed, not that they ran against the thing their names claim.** Only mutation testing distinguishes those.

**Restraint recorded.** `src/scripts/parsers/fcpxm.js` (23.7 KB) was examined and left alone: it has **no importers** and is the dead twin of the live `fcpxml.js`. Iteration 3 established that testing or repairing an unused duplicate produces coverage numbers and no safety. It is listed here so the next pass does not rediscover it as an opportunity.

**Audit scorecard (13 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; J2K decoder routing → 1 high + 3 medium + 1 low, fixed; decode-route observability → 3 medium + 1 low, fixed; unbounded fast-path retry → 2 medium + 2 low, fixed; codec identification → 1 high + 5 medium, fixed; SIZ parsing → 3 medium + 3 low, fixed; **ALE import → 2 high (1 fixed, 1 open) + 2 medium + 2 low.** Nine of thirteen areas held a defect with no visible symptom; this is the first whose symptom was visible and still went unreported, because the symptom was silence.

## 2026-07-26 (14th area) — The whole-frame timecode base: a bug that three correct comments were routing around

Scope: `src/scripts/modules/utils_time.js`, the canonical exported `tcToFrames`/`framesToTC` pair — the lowest-level timecode conversion in the app, imported by **607 call sites**.

Timecode counts frames on a **whole-frame base**. A 23.976 fps timeline fits 24 frame fields into a timecode second; 29.97 non-drop fits 30. The fractional rate is the *playback* rate and is not representable in `HH:MM:SS:FF` — 24 distinct frame fields do not fit into 23.976 frames. The bare pair took the `fps` argument at face value and multiplied by it.

| Call | Returned | Timecode says | Error |
|---|---|---|---|
| `tcToFrames('00:00:01:00', 23.976)` | 23 | 24 | −1 frame |
| `tcToFrames('00:10:00:00', 23.976)` | 14385 | 14400 | −15 frames |
| `tcToFrames('01:00:00:00', 23.976)` | 86313 | 86400 | **−87 frames (3.6 s)** |
| `tcToFrames('01:00:00:00', 29.97)` | 107892 | 108000 | −108 frames |
| `framesToTC(86400, 23.976)` | `01:00:03:14` | `01:00:00:00` | drifts |
| round-trip `'01:00:00:00'` @23.976 | `00:59:59:23` | `01:00:00:00` | **not invertible** |

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | `tcToFrames` multiplied by the fractional rate, so at 23.976/29.97/59.94 it returned a frame count that was neither the timecode's nor invertible. A one-hour start TC came back 87 frames short of itself; a five-second span measured **119 frames instead of 120** — the shape of a VFX pull that arrives one frame short. | Fixed (`nominalBase`) |
| 2 | **High** | `framesToTC` divided by the fractional rate, so it drifted in the opposite direction and the pair did not round-trip at any fractional rate. | Fixed (`nominalBase`) |
| 3 | Medium | The fuzz suite asserted this pair's "nominal-base contract" **while fuzzing it only at 24/25/30/50/60** — the five rates where the nominal base and the rate are the same number, i.e. the only rates at which the contract is vacuous. | Fixed (all 8 rates) |
| 4 | Medium | `tcToFrames` ended in `| 0`, a 32-bit truncation. On a whole-frame base the product is already an integer, so it did nothing except impose a silent wrap at 2^31 frames. | Fixed (`Math.round`) |
| 5 | Low | Neither `framesToTC`'s negative-frames clamp nor any unusable-`fps` behaviour was tested. Found by a **surviving mutation**, not by reading: with the clamp deleted, `framesToTC(-5, 24)` returns `"-1:59:59:19"`, which re-parses as a positive time. | Fixed (2 assertions) |
| 6 | Low | `src/scripts/parsers/fcpxml.js:336` has a private `tcToFrames` matching `/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/` — colon-only, exactly-two-digit — and **returns `0`** on no match. A silent zero, not a rejection. | **Open** (logged) |
| 7 | Low | `src/scripts/parsers/prproj.js:465`'s `_tcToFrames` does `String(tc||'').split(':')` — no `[:;]`, no subframe strip. Same drop-frame blindness area 13 fixed in `ale.js`. | **Open** (logged) |
| 8 | ~~Medium~~ → **High** | `src/scripts/modules/edl_export.js` defines **local** `tcToFrames`/`framesToTC` (~lines 105 and 113). Its `framesToTC` computes `const ff = frames % fps` — at a fractional `fps` this yields a **fractional frame field**. ⚠️ **This row was wrong on one point and understated on another; both corrected 2026-07-26 in iteration 11 — see the 15th area below.** The claim that the local copies "shadow the file's own imports from `utils_time.js`, making those imports dead" is **false**: `edl_export.js` had *no imports at all*. They are private copies with nothing to shadow. Severity was also too low — the consequence is not garbage in a comment field but a **silently zeroed REC timeline in the delivered EDL**. | **Fixed** (iteration 11) |

**Why this survived in the most-imported function in the app.** Because three separate places already knew the rule and each worked around the bare pair *on the way in*, rather than fixing it:

1. `timecodeToFrames` — the settings-aware wrapper directly above it — calls `tcToFrames(tc, Math.round(fps))`, with a three-line comment explaining that 23.976 uses a 24-frame base and that "using the fractional fps here breaks frame↔TC round-trips". It defends itself against its own callee and says why.
2. `xml.js::normFps` does `Math.round(n)` before every conversion, commented *"For 23.976/29.97/59.94, use nominal integer for TC formatting."*
3. `timecodeFuzz.test.mjs` labels the pair's contract "nominal-base" — and fuzzes it only at the rates where that label means nothing.

So the rule was written down three times, correctly, and applied nowhere at the bottom. Every caller sophisticated enough to know about the problem pre-rounded and moved on; the 607 that did not know inherited the bug. **A wrapper that defends itself against its own callee hides the callee's defect from every other caller** — and the defence is indistinguishable from documentation, so it reads as diligence rather than as an unfixed bug.

**The test's exclusion list was the bug report.** `[24, 25, 30, 50, 60]` is not an arbitrary set of rates; it is precisely the set on which the broken code is correct. A reviewer looking for gaps would have found this faster by reading which rates the suite *skipped* than by reading the code it covered. Extending the list to all eight supported rates is a proof that could not have passed before the fix.

**Load-bearing check before touching 607 call sites.** Iteration 7 established that a bug can be load-bearing. The risk here was real: `t × 23.976` divides back to *correct seconds*, so code doing `frames / fps` for seek or duration would have been silently depending on the wrong frame count. I verified the only `/fps` seconds arithmetic in the pull/export/timeline modules is `edl_export.js:116`, which lives inside that file's **own local** `framesToTC` and never sees the imported one (finding #8). And no existing assertion anywhere pinned the old values. Rounding inside the pair is therefore a **no-op for every integer-rate caller** and repairs exactly the set that was wrong — confirmed by the full suite passing unchanged, including `aleParser.test.mjs`, whose cross-parser assertion is *relative* (both sides moved 107892 → 108000 together).

**Why round-trip fuzzing was not sufficient evidence.** The fuzz property `tcToFrames(framesToTC(f, fps), fps) === f` would also hold for a **wrong but self-consistent** base — floor 23.976 to 23 and every round-trip still closes. Invertibility cannot distinguish base 24 from base 23; only a known absolute frame count can. The mutation sweep proved this rather than assuming it: `Math.round` → `Math.floor` in `nominalBase` was caught **only** by the new absolute goldens in `timecode.test.mjs`, never by the 4000-sample fuzz. This is the fourth instance this run of one lesson — *a green suite tells you the assertions passed, not that they ran against the thing their names claim* — and the first where the insufficient assertion was a **property test**, which is the kind usually trusted most.

**Mutation results: 10 mutants, 8 caught, 2 surviving and provably equivalent.** The two survivors are reported as equivalent rather than as gaps, with the argument: `Math.ceil` ≡ `Math.round` for `nominalBase` because all three fractional rates in `FPS_PRESETS` (23.976, 29.97, 59.94) sit below the .5 boundary of their integer base and every other supported rate is already an integer; and `Math.trunc` ≡ `Math.round` in `tcToFrames` because on a whole-frame base the operand is an integer. Neither is reachable by any input the app accepts, so no test was added for them — a test that cannot fail is the thing this iteration was investigating.

**Audit scorecard (14 areas):** IPC/preload+XSS → 2 fixed; path-traversal → 1 fixed; IPC read/delete → clean; HTTP server → clean; verification integrity (Python) → 1 high + 1 medium + 1 correctness, fixed; verification integrity (JS) → 1 medium fixed + gate added; engine routing → 1 high + 2 medium + 1 low, fixed; J2K decoder routing → 1 high + 3 medium + 1 low, fixed; decode-route observability → 3 medium + 1 low, fixed; unbounded fast-path retry → 2 medium + 2 low, fixed; codec identification → 1 high + 5 medium, fixed; SIZ parsing → 3 medium + 3 low, fixed; ALE import → 2 high (1 fixed, 1 **narrowed by retraction**) + 2 medium + 2 low; **whole-frame timecode base → 2 high + 3 medium + 3 low; 5 fixed, 3 logged open.** Ten of fourteen areas held a defect with no visible symptom.

---

## 2026-07-26 (15th area) — The private timecode copy in the EDL exporter: a sanitizer that hid the defect it was catching

**Live, not latent, and the loudest failure mode this run.** At every fractional frame rate, `buildEDLFiles` emitted a delivery EDL in which **every REC IN and REC OUT column was `00:00:00:00`** — an entire record timeline of zero-duration events. At every integer rate the same input was correct. Reproduced end-to-end through the real modules, no mocks: an ALE whose header reads `FPS 23.976` (`ale.js:60` takes the header value verbatim; `ale.js:173` stamps it onto every event as `ev.fps`) parsed and handed to `buildEDLFiles`, which reads `Number(events[0]?.fps)` at line 807.

| | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | `edl_export.js::framesToTC` computed `frames % fps` and `(frames - ff) / fps` on the **fractional** rate. A five-second span at 23.976 measured 119.88 frames and formatted as `"00:00:05:0.12000000000000455"` — a fractional frame *field*. | Fixed |
| 2 | **High** | `safeTC` (line ~126) then converted that visibly-broken string into a **plausible** one. Its `/^\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}$/` guard rejects the malformed value, `Number()` of it is `NaN`, and the function returns `"00:00:00:00"`. The guard did not prevent the loss; it **concealed** it. | Fixed at source |
| 3 | Medium | The duration was wrong before the formatting was, and by a different amount: 119.88 frames where timecode says 120. Same whole-frame-base defect as the 14th area, in a private copy that the 14th area's fix could not reach. | Fixed |
| 4 | Medium | `tests-js/edlExport.test.mjs` pinned `fps: 24` in **every one of its 17 tests** — zero occurrences of 23.976, 29.97 or 59.94 in the file. The rates a real ALE or FCPXML actually carries were the only ones untested, and the only ones broken. | Fixed (7 tests added) |
| 5 | Low | `utils_time.js::tcToFrames` returns **`NaN`** for a short or unparseable timecode (`'01:00:00'`, `'garbage'`) where `edl_export.js`'s stricter local parser returns `0`. | **Open** (logged) |

**Why the guard made it worse.** `00:00:05:0.12000000000000455` is not a timecode. Any conforming CMX3600 reader rejects it, and the operator learns immediately that the export is broken. `00:00:00:00` is a *well-formed* timecode that every reader accepts, so a pull with a destroyed record timeline conforms, imports, and is wrong. `safeTC` sits between the two and turns the first into the second. The heuristic, stated generally: **a wrapper that defends itself against its own callee converts a loud failure into a quiet one, and hides the callee's defect from every other caller.**

**Why convergence was partial, on purpose.** The obvious fix — delete the private pair and import the exported one, per the 4th area's heuristic — was measured before being applied, and rejected. `utils_time.js::tcToFrames` is *lenient* by design: `tcToFrames('01:00:00', 24)` returns `NaN`, and `tcToFrames('garbage', 24)` returns `NaN`, where the exporter's strict regex-gated parser returns `0`. Swapping wholesale would have replaced a defensive zero with `NaN` **inside a delivery-artifact writer** — trading a known bug for an unknown one. Only `nominalBase` was shared (promoted from private to exported in `utils_time.js`); the strict parser stays local, with a comment recording why. *Converging duplicated logic is right; converging duplicated logic without diffing the behaviours first is how the next defect gets introduced.*

**The mutation sweep found a gap that all seven new assertions missed.** Six mutants, five caught. The survivor that mattered: flooring `nominalBase` to 23. Every cross-rate assertion — including `assert.equal(build(evs(23.976)), build(evs(24)))` — **still passed**, because a wrong base used *consistently* cancels out: count five seconds as 115 frames on base 23, format back on base 23, get `00:00:05:00`. Inside this file frames never escape the timecode domain, so the base is unobservable — except at the one door where an absolute frame count crosses in, `ev.durFrames` in `rebuildRecFromZero`. A test through that door (`durFrames: 120 @23.976` must be `00:00:05:00`, not `00:00:05:05`) catches it. This is the **fifth** instance this run of the same lesson, and the second consecutive iteration in which the *cross-check between two representations* was the inadequate assertion. The remaining survivor, `Math.ceil` for `Math.round`, is reported as equivalent: every rate in `FPS_PRESETS` is either an integer or sits just below one.

**A structural assertion, not just a golden.** Because `safeTC` masks malformed values before any column-level assertion can see them, one test scans the entire emitted EDL text at eight rates under three option sets and fails on *any* timecode-shaped run containing a fractional or over-long field. Pinning individual columns would not have caught this class; the masking layer is exactly what defeats column-level checks.

**Audit scorecard (15 areas):** …as above, plus **private timecode copy in EDL export → 2 high + 2 medium + 1 low; 4 fixed, 1 logged open.** Eleven of fifteen areas held a defect with no visible symptom.

---

## 2026-07-26 (16th area) — `ui.js`'s private timecode parser: the safe-looking return value that killed a fallback chain

**No source changed this iteration.** Everything below is evidenced by runtime probes against exact transcriptions of the live functions. The one code change this iteration would have made was rejected on scope grounds — see "Why nothing was shipped" at the end. Read that before acting on the table.

This started as the follow-up I logged at the end of iteration 11: *"`utils_time.js::tcToFrames` returns `NaN` for short or garbage input — worth its own scoped pass."* **That item is retracted.** The investigation inverted it.

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | `ui.js:397-399` — the rec-duration fallback inside `computeEdlRecMap`'s `durFramesFor` is **unreachable dead code**. Any event whose source timecode is absent, empty, malformed, drop-frame, or 3-part gets record duration **0**. | Open |
| 2 | **High** | Drop-frame source timecode (`01:00:00;00`) yields duration **0**. `ui.js:273`'s regex is `^(\d+):(\d+):(\d+):(\d+)$` — colon-only, no `[:;]`. Valid SMPTE timecode, silently zero. | Open |
| 3 | Medium | `ui.js:362` — `if (!Number.isFinite(fr)) continue;` is a **dead branch**. The function it guards cannot return a non-finite value. | Open |
| 4 | Medium | `ui.js:273`/`:279` carry the **same fractional-rate defect fixed in `edl_export.js` this morning** — `*fps` and `fr % fps`. Unlike `edl_export.js` there is **no `safeTC`**, so the malformed string reaches the UI verbatim. | Open |
| 5 | — | **Retraction of the iteration-11 follow-up.** `utils_time.tcToFrames` returning `NaN` is **correct and load-bearing**, not a defect. | Retracted |

### The mechanism, and why it is the exact inverse of what I logged

`ui.js` has its own private `tcToFrames` at line 273 — a **fourth** copy, after `utils_time.js`, `edl_export.js`, `fcpxml.js` and `prproj.js`. It differs from the exported one in one decisive respect: on a non-match it **returns `0`, not `NaN`**.

`durFramesFor` (`ui.js:389-400`) is a three-strategy fallback chain: explicit `durationFrames`, else source duration, else record duration, else 0. Strategy two reads:

```js
if (Number.isFinite(si) && Number.isFinite(so) && so >= si) return Math.max(0, so - si);
```

Because the local parser never returns `NaN`, `Number.isFinite` is a **tautology** here. Malformed source timecode gives `si = so = 0`, `0 >= 0` holds, and the branch returns `Math.max(0, 0)` — **zero**. Strategy three never runs. Probe against an exact transcription, every case a genuine five-second event with valid record timecode (all should be 120):

| Event | `durFramesFor` @24 |
|---|---|
| src + rec, both valid | 120 ✅ |
| src **absent**, rec valid | **0** ❌ |
| src **empty string**, rec valid | **0** ❌ |
| src **malformed**, rec valid | **0** ❌ |
| src **drop-frame** (`01:00:00;00`), rec valid | **0** ❌ |
| src **3-part** (`01:00:00`), rec valid | **0** ❌ |

`Number.isFinite(tcToFrames(t, 24))` is `true` for every one of `null`, `undefined`, `''`, `'garbage'`, `'01:00:00;00'`, `'1:2:3'`. The guard cannot fail.

**The lesson, and it is the sharp one.** I logged the `NaN` as a bug to fix because a `NaN` escaping a parser looks like sloppiness. It is the opposite: roughly twenty call sites — `ui.js:362`, `:394`, `:398`, `shotWorkItems.js:77`, `prep_mark.js:15560`, `:16135` and others — use `Number.isFinite` to mean *"this timecode is unusable, skip it or try the next strategy."* `NaN` is the channel that message travels on. Had I "fixed" it, every one of those loud skips would have become a silent wrong number.

And `ui.js` is the proof, because it already made that mistake: its parser returns the safe-looking `0` instead of `NaN`, and that single choice is what turned its fallback chain into dead code. **A sentinel that passes the caller's validity check is worse than a value that fails it.** This is iteration 11's `safeTC` lesson in a second costume — there, a sanitizer replaced a rejectable timecode with an acceptable one; here, a parser replaces an unusable frame count with a usable-looking one. Both convert a loud failure into a quiet one, and both look like defensive programming.

### The fractional rate reaches it

Finding 4 is not theoretical. `normalizeFpsNominal` (`ui.js:294`) exists precisely to keep fractional rates away from these helpers — the **fifth** caller-side workaround for a callee defect found this run, and its comment says so outright: *"UI timecode helpers in this project assume an integer FPS."* But two of the three `computeEdlRecMap` call sites do not use it:

- `ui.js:6344` — `const _fpsForRec = ... (view[0].fps || view[0].rate || qsState.fps || 24)`
- `ui.js:19205` — the same expression

`parseALE` stamps `ev.fps = 23.976` on every event from an ALE header reading `FPS 23.976` (`ale.js:60`, `:173`). So `view[0].fps` is `23.976` on the ordinary dailies path. Measured consequences:

- `tcToFrames('01:00:00:00', 23.976)` → **86313.59999999999** (timecode says 86400)
- `framesToTC(120, 23.976)` → **`"00:00:05:0.12000000000000455"`**, and with no `safeTC` in this file it goes to the UI as-is.

### Why nothing was shipped

Three reasons, all of which would have to be false before this is a safe change:

1. **`durFramesFor` and `computeEdlRecMap` are private to `ui.js`** — not exported, not on `window`, unreachable from `tests-js/`. Any test would have to transcribe them, and iteration 3 already established that *a test on the unused twin of a live function is not coverage*. A fix here would ship with zero real assertions behind it.
2. **`src/scripts/ui.js` is already dirty** — 32 insertions / 7 deletions of pre-existing uncommitted work. Committing it needs the same backup-restore-reapply dance `edl_export.js` needed this morning, on a 20,000-line file, and that manoeuvre earns its risk only when the change behind it is verified. This one is not.
3. **`ui.js` cannot be exercised at all in this environment.** It is the DOM-coupled renderer entry point; `node` cannot load it and `build:renderer` only copies files, so a broken edit produces a green build and a broken app. Reasons 1 and 2 are the deciding ones — this was *not* a clock decision. There was roughly an hour left when I stopped, and I stopped anyway, because more time does not create a way to verify the change.

The correct fix is a small extraction — lift `durFramesFor` into `src/scripts/modules/` as an exported helper, point `ui.js` at it, and test it directly — together with converging `ui.js:273`/`:279` onto `nominalBase` the way `edl_export.js` was converged. That is a scoped daytime pass with a clean working tree, not an unattended one.

---

## Iteration 13 — the survey behind the fix, and what it turned up

The fix itself is in the backlog and in `64b2848`. This is the part that changes what the next iteration should do.

### There are seventeen private `tcToFrames`, not five

Overnight I had mapped five. A sweep of `src/` found **seventeen** files defining their own timecode parser. Classified by the two defects this run has been chasing — counting on the fractional playback rate instead of the whole-frame base, and returning a sentinel that passes the caller's own validity check:

| File | Base | Sentinel |
|---|---|---|
| `modules/utils_time.js` | `nominalBase` ✅ (it10) | `0` / NaN |
| `modules/edl_export.js` | `nominalBase` ✅ (it11) | `0` |
| `modules/eventDuration.js` | `nominalBase` ✅ (it13, new) | **NaN** |
| `modules/conform/edlParser.js` | `Math.round` ✅ + real drop-frame math | `0` |
| `modules/workers/aaf_worker.js` | `Math.round` ✅ | `0` |
| `features/tl_convert/index.js` | `Math.round` ✅ | `0` |
| `parsers/xml.js` | `normFps` ✅ | `0` |
| `ui.js` | **raw fps** → fixed it13 | `0` (kept, deliberately) |
| `features/edl/timelineAutoInject.js` | **raw fps** ❌ | NaN |
| `features/edl/pipeline/recOffset.js` | **raw fps** ❌ | `0` |
| `features/reviews/store.js` | **raw fps** ❌ | `0` |
| `modules/cutdiff.js` | **raw fps** ❌ | `0` |
| `modules/filters.js` | **raw fps** ❌ | `0` |
| `modules/amf_convert.js` | **raw fps** ❌ | `null` |
| `parsers/fcpxml.js` | **raw fps** ❌ | `0` |
| `parsers/otio.js` | **raw fps** ❌ | `0` |
| `smart/smartExrPullPlanner.js` | **raw fps** ❌ | NaN |
| `parsers/fcpxm.js` | raw fps — **no importers, do not touch** (it3) | `0` |

**Eight live files still count timecode on the playback rate.** At 23.976 or 29.97 every one of them produces a non-integer frame count from a valid timecode. That is iteration 14: converge them onto the exported `nominalBase`, one file at a time, each with its own before/after probe — *not* a sweep. Iteration 10's lesson stands: converging duplicated logic without diffing the behaviours first is how the next defect gets introduced. The base is the only thing worth sharing; each file's regex and sentinel are load-bearing for its own callers and must be left alone.

### `nominalBase` has a small hole of its own

`nominalBase(fps)` guards `fps <= 0` and then returns `Math.round(n)`, so a rate in `(0, 0.5)` returns **`0`** — a base of zero, which makes `framesToTC` divide by zero. `ui.js`'s local `normalizeFpsNominal` does not have this hole; it falls back to 24. No caller can currently produce such a rate, so this is recorded rather than patched: changing a function four modules now share is not a change to make on the strength of an input nobody can supply. If iteration 14 touches `utils_time.js` for another reason, `Math.round(n) || 1` closes it.

### A sixth caller-side workaround, and what the count now means

`ui.js:7970` carries this, in the caller's own words:

```js
// tcToFrames() returns 0 on parse fail; we need strict parsing here.
const parseTC = (s) => { ... return Number.isFinite(f) ? f : null; };
```

That is the sixth place in this codebase where a caller writes a private workaround for a defect in something it calls, and the second where the comment names the defect outright. The running lesson — *a wrapper that defends itself against its own callee hides the callee's defect from every other caller* — now has a corollary worth stating separately: **the workarounds are a census of the defect.** Six callers wrote a guard; the two duration chains did not, and those are exactly the two that were broken. Grepping for the defence found the sites missing it faster than reading the parser did.

### Method note: the test names had to be earned

The new suite's assertions are labelled `(was 0)`. A label is a claim, and iteration 12's lesson is that *a green suite tells you the assertions passed, not that they ran against the thing their names claim*. So the pre-fix chain was transcribed verbatim into `/tmp/probe13.mjs` and run beside the new module on the same inputs; every `(was 0)` is a number that probe printed. The one case where old and new agree — a reversed source span, which already fell through to the record columns — is labelled as agreeing, because it did.

---

## Iteration 14 — the inverse bug class, and four things the method got wrong

### Correction to the table above: seven live files, not eight

`features/edl/pipeline/recOffset.js` is on that list and has **zero importers** — verified against dynamic imports as well as static ones. It is orphaned dead code carrying a real defect. It should be deleted or wired up; it should not be "fixed" in place, because fixing it would make it look maintained. The live count is **seven**.

Also demoted: `parsers/otio.js`'s `tcToFramesLocal` (`:835`) is used at exactly one place — `:840`, as a **sort key**. Every element is scaled by the same factor, so the base cannot change the ordering. It is on the list for consistency, not for impact.

### The new bug class: a *rounded* rate used for a seconds→frames conversion

Every defect this loop has found so far is the same shape — timecode counted on the fractional playback rate, producing a fractional frame field that `padStart` stringifies whole. That makes a **label malformed**, and it is obvious the moment you see it.

`fcpxml.js` had the mirror. FCPXML stores time as a rational number of **real** seconds; the frame it denotes is `value / frameDuration`. Rounding the rate and multiplying by it makes every position **drift**, and the error grows linearly with position: 86 frames late at the 1-hour mark of a 23.976 timeline, 172 at two hours. Nothing looks malformed. Every timecode is well-formed. The reel is just *wrong*, more so the further down it you look — which is precisely the failure mode a human spot-check at the head of a reel will not catch.

**The rule that follows: rounding a rate at the *source* is more dangerous than rounding it at the point of use.** `fcpxml.js` rounded in the formats map and in `readFPS` — the two places the rate is read from the file — so every downstream conversion inherited it, including the ones that needed the true rate. Round at the point of use, where the reader can see which kind of conversion is being done.

**Corollary, and why the fix looks odd:** a file that does both kinds of conversion needs **two rates**, and that is not a smell to be tidied away. `fcpxml.js` now threads the exact rate internally and wraps `nominalBase()` at the two places a whole number is required plus every place a rate leaves the module. A future reader who "simplifies" this back to one rate reintroduces one bug or the other, which is why the split is stated in a header comment rather than left to be inferred.

### Four method failures worth recording

**1. A static-import grep proves nothing about whether a module is live.** My first pass grepped `from '…fcpxml'` and got **zero hits**. I nearly filed the file as dead code — which would have meant skipping the single most severe defect in the whole loop. It is reached through six `await import(...)` sites (`ui.js:13592/13603/13616`, `prep_mark.js:2909/2919`, `reviews/index.js:9524`). **Never declare a module orphaned without a pattern that catches dynamic imports.** This also retroactively raises the bar on `recOffset.js` and `fcpxm.js` above — both were re-checked against dynamic imports before being called orphaned.

**2. A whole test file written at fps 24 is blind to base bugs.** Both pre-existing `fcpxml` tests ran at 25 and 24, and every `cutdiff` assertion ran at 24. At an integer rate the nominal base and the playback rate are *the same number*, so no assertion in either file could distinguish the two — the suites were green and structurally incapable of failing on this. A rate-sensitive module needs at least one fractional rate in its fixtures or its coverage of this class is zero.

**3. A fallback whose replacement value is derived from the field it is defaulting is tautological.** `cutdiff.js`'s `ev.recIn || framesToTc(nf.recInF, fps)` looks like a real fallback. It is not: `nf.recInF` is `tcToFrames(ev.recIn)`, so the branch only runs when `ev.recIn` was falsy, which means the parse returned 0, which means the fallback can only ever emit `"00:00:00:00"`. Worth spotting for two reasons — the "fallback" is dead, and any bug inside it is unreachable.

**4. An unreachable defect is still a defect, but say which it is.** I wrote a source comment claiming `framesToTc` was emitting malformed timecodes before checking whether it could be called with a non-zero argument. It cannot. Corrected the source comment, the test comment and the commit message before committing. Fixing it is right — the next caller will not be shielded by that accident — but banking it as an observable fix would have been a false claim in a document whose whole value is that its claims were verified.

### Where the convergence stands

Converged: `reviews/store.js`, `modules/cutdiff.js`, `parsers/fcpxml.js` (this iteration), plus `ui.js`, `eventDuration.js`, `edl_export.js` and the rest from iterations 10–13.

Remaining, in priority order: **`modules/amf_convert.js`** — three private copies (`:1563` `tcToFramesLocal` + a `framesToTc`-alike at `:1571`, `:2517`, `:4337`) with consumers at 1626, 4594, 4595, 4740 (`framesToSec` — check which kind of conversion that is before touching it) and 4800. Then `features/edl/filters.js` (not yet surveyed) and `features/edl/timelineAutoInject.js` (private `tcToFrames` at `:53` returns NaN on failure, uses the raw fps, but has no `/ fps` anywhere and its values are used relatively for lane allocation — low impact, DOM-dependent, hard to test here).

Do **not** touch `parsers/fcpxm.js` or `features/edl/pipeline/recOffset.js`. Both have zero importers, confirmed against dynamic imports.

---

## Iteration 15 — `fps` meant three different things

**Severity: high.** Not a single defect — a defect *class*, and the source of most of the rate bugs iterations 10–14 fixed one file at a time.

### The finding

Six parsers, one field name, three meanings. `fcpxml`/`prproj`/`otio` reported the nominal whole-frame base; `xml.js` reported the true playback rate; `edl.js`/`ale.js` reported the file header verbatim, which for `FRAME_RATE: 23.976` is fractional. Consumers cannot introspect which they received, so each guessed. `trlconf` guessed "nominal" and conformed an NTSC hour to **86313.686** frames instead of 86400 — short *and* fractional. `prep_mark` guessed "playback" and reached past `fps` for `timecodeBase`.

### The finding underneath it

`_pmFpsToRational` (`prep_mark.js:77`) maps 23.976 → `24000/1001` but **falls through to `{num: Math.round(fps), den: 1}`**. Because `xml.js` alone reported the exact rate, XMEML was the only import whose A/V clock ran at the correct rational. An NTSC **FCPXML** reported `24`, matched no NTSC branch, and drove the clock at `24/1` — **0.1% fast, 3.6 seconds of drift per hour against the media.**

The two consumers of that one number needed opposite values and **both were right**. That is the proof the field was overloaded rather than merely wrong: no single value could satisfy both, so no amount of correcting `xml.js` would have fixed it. Splitting into `fps` (whole timecode base) and `fpsExact` (true playback rate) is the only fix that leaves both consumers correct.

### Heuristics added

- **When two correct consumers demand different values from one field, the field is overloaded — stop fixing the producers.** Iterations 10–14 were each a locally-correct fix to a globally-underspecified contract. The tell is a wrapper or consumer that *reaches past* the obvious field for a sibling (`timecodeBase`): it is reporting the contract gap.
- **A scan can be accurate and still ask the wrong question.** Iteration 14 recorded that `ale.js`/`edl.js` "have no rate arithmetic." True — and irrelevant. They copy a fractional header value straight into `fps`. A rate does not have to be *computed* wrong to *be* wrong; the scan should have asked what the field contains, not what math produced it.
- **Look at real output before writing assertions.** My own NTSC fixture double-counted source timecode (`<in>` is an offset into the media, so `srcIn = fileTC + in`). Writing assertions from the observed numbers would have recorded my fixture bug as correct parser behaviour, in a file whose name claims to protect the parser.
- **A failing pre-existing test may be asserting the contract you just replaced.** Two ALE assertions read the fractional rate off `fps`. The repair is to move the assertion to the field that now carries the fact — not to relax it, and not to delete it.
- **`git update-index --chmod` re-stages file content.** It re-registered all 973 dirty lines of `prep_mark.js` over my carefully isolated 11-line hunk. Caught only by re-reading `git diff --cached --stat` after the chmod. Verify the index after every operation on it, including ones that sound metadata-only.

### Still open (unblocked by this contract)

- `trlconf/index.js:2303` — `delta / state.fps` is the one site in that file wanting the *true* rate; repoint at `fpsExact`.
- `modules/amf_convert.js` — three private TC helper copies, plus `framesToSec` at `:4342` and the `ensureComp` comp rate at `:4740` inside **generated After Effects ExtendScript**, which cannot import `nominalBase`. Both rates must be threaded in via `JOB`.
- `aaf_wasm.js` is not covered by `assertParseResult` and was not converted.

---

## Iteration 16 — the visual conform engine seeks by the wrong clock

**Severity: high, and asymmetric in a way that explains why nobody caught it.**

### The finding

`trlconf/index.js` converts frames↔seconds on `state.fps` — the whole-frame timecode base — at roughly twenty sites. On any NTSC show the base is 0.1% away from the true playback rate: **3.6 seconds, ~86 frames, at the one-hour mark.** Three of those sites matter very differently:

1. **The master search self-corrects.** `_searchMasterForFrame` gives its hint a ±30 s coarse window. A 3.6 s error is well inside it, the match still lands, and nothing looks wrong.
2. **The reference seek has no window at all.** `_seekVideo(refVideo, refSec)` then hash, directly. A rate error here does not *degrade* a match — it hashes **a different shot and matches that, with full confidence.** There is no signal, because a confident match on the wrong frame is indistinguishable from a confident match on the right one.
3. **The range guard turns the overshoot into a silent drop.** `if (unmrefSec < 0 || unmrefSec >= refDuration - 0.1) { console.warn(...); continue; }` — an event near the tail of a long reference overshoots, logs to a console nobody has open, and leaves the conform with **no row and no error**.

`_refineSourceOut` is worse still and is *not* fixed here (it does not exist in HEAD): its windows are `coarseWindowSec: 0.9` / `fineWindowSec: 1.2`, so 3.6 s is far outside them. It does not degrade on NTSC — it **silently no-ops**, under a doc comment claiming it "can only improve accuracy, never regress it." That is the next item.

### This is my regression, not a discovery

Iteration 15 made `state.fps` the whole base on every path. Before it, XMEML reported 23.976, so these seeks were *right* and `_tcToFrames` was wrong. It15 fixed the conform math and, in doing so, made the seeks consistently wrong on every NTSC source. Recording it as a fresh find would misrepresent both iterations.

### The finding that should change how the loop reads a green build

`grep -rln "trlconf" test/ tests-js/` matches exactly one file — `test/parsers/xml.test.mjs` — and only in two **comments** (lines 46 and 77). **No test imports `trlconf/index.js`.** `build-verify` has never executed a line of the visual conform engine. That is how a rate defect lived in it through fifteen green iterations, and it means "build-verify green" is not evidence about this file. Stated in the commit message rather than left implied.

This is the existing heuristic *"a green suite tells you the assertions passed, not that they ran against the thing their names claim"* in its strongest form yet: here the assertions do not merely test something else, **the file has no assertions at all.**

### Heuristics added

**1. Line-level cleanliness does not imply hunk-level isolability.** I verified every line I touched was byte-identical to HEAD and concluded the hunks were separable. `git diff -U0` still merged 5 of 24 of them with foreign work, because git groups by *adjacency*, not by authorship. In a file with 155 hunks, "my line is clean" and "my hunk is clean" are different claims and only the second one is the one that matters. When they diverge, stop splitting hunks and reconstruct the intended blob from HEAD instead.

**2. A substring count is not an anchor — `count(old) == 1` can pass on the wrong line.** This is the sharp one. My apply script asserts an exact occurrence count before every replacement, and that mechanism had already caught one bad target (the `reset` line, whose HEAD text is column-aligned as `state.fps                = DEFAULT_FPS;`). It then let a worse one straight through: the session-save target `"      fps: state.fps,"` counted exactly **1** — but the match was the *tail* of a 14-space-indented `              fps: state.fps,` at the conform call site. HEAD's real session-save line is `      fps:              state.fps,`. So the edit landed in the wrong function, produced a duplicate misindented property, and the real `exportState()` never got the field — meaning saved sessions would have silently lost `fpsExact` on every reload. **Caught only by reading the full reconstructed diff before staging, not by the assertion that was supposed to catch it.** The guard is now a line-boundary check as well as a count: an indented target must also start at a line start. A verification that can be satisfied by the wrong thing is not a verification.

**3. Both of this iteration's near-misses are the same root mistake as iteration 15's.** Every one came from reconstructing an `old_string` from memory or from the working tree instead of reading the live HEAD bytes — and column alignment is where it bites, because the eye normalises whitespace and `count()` does not. Read the bytes.

**4. `git add` re-introduces working-tree mode bits.** Adding the clean `ai_matcher.js` swept in a 644→755 flip alongside the content. Fixed with `git update-index --cacheinfo 100644,<same-sha>,<path>` — which sets the mode against an explicit blob — rather than `--chmod`, which iteration 15 established re-stages content. Verified with `git diff --cached --summary` returning empty.

### Still open

- **`_refineSourceOut`** — highest priority once it lands in HEAD; it no-ops rather than degrades, so it will keep looking like a feature that simply never helps.
- The three other `_matchEventByVisualWave` call sites and their `unmrefSec` / `corrSrcSec` duplicates (library-match, AI, reel-match), currently in-tree only.
- **A test that imports `trlconf/index.js` at all.** The rate fix is unverified by machine; only the reasoning and the diff back it. Extracting the frames↔seconds helpers into something importable would be worth more than any further fix inside the file.
- Carried from it15: `modules/amf_convert.js` (three private TC helpers, `framesToSec` at `:4342`, `ensureComp` at `:4740` — generated ExtendScript, rates must be threaded via `JOB`), `aaf_wasm.js` outside `assertParseResult`, `features/edl/filters.js` unsurveyed, `timelineAutoInject.js:53`, `prproj.js:465`.

## Iteration 17 — the carried backlog, checked against the code instead of against itself

A survey iteration. No source change. Its value is that it **removed** three items from the still-open list by proving they were not defects worth an iteration, and correctly classified a fourth that looked like an easy win.

### 1. `features/edl/filters.js` — the path is stale

Carried since iteration 15 as "unsurveyed". The file does not exist and, going by the report history, never did. The three real filter modules are `modules/filters.js` (live — reached only through `await import()` at `ui.js:114`, so it shows zero hits on a static-import grep), `modules/filters_common.js`, and `modules/filters_vfxRename.js`.

### 2. `filters_common.js` — the defect in miniature, in a file production cannot reach

`tc(x, fps=24)` contains the whole it15/it16 pattern in twenty-one lines:

```js
const fr = Math.round(num/den * fps);            // real media time  → wants the EXACT rate
const ff = String(fr % fps).padStart(2,'0');     // timecode field   → wants the BASE
```

At a fractional rate `fr % 23.976` yields a fractional frame field, and — the it15 heuristic again — **`padStart` does not round**, so the output is `00:00:00:5.28`. A textbook case.

It is also unreachable from the app. The only consumer repo-wide is `tests-js/filtersVfxRename.test.mjs:8`. Recorded, not fixed.

### 3. `aceslook` — two defects in one function, and only one of them is real

`_framesToTC(totalFrames, fps)` at `index.js:2159` decomposes with `totalFrames % fps`, so on a fractional rate it prints a fractional frame field. But all three `_addTcOverlay` call sites (`:1939`, `:2031`, `:2131`) pass **no** `fps` and take the `fps = 24` default, and `fps` occurs exactly 10 times in the entire file — all ten accounted for by the helper and the overlay. **The feature has no clip-rate source anywhere in it.** So:

- The fractional-frame-field defect is **unreachable** — it cannot be triggered by any current caller.
- The reachable defect is different and duller: the overlay hardcodes 24, so it reports the wrong frame on any non-24 clip, and on a 25 fps source two distinct timecodes (`00:00:00:24` and `00:00:01:00`) collapse onto the same frame number.

Fixing the reachable one means introducing a rate source the feature does not have — new plumbing, not a local edit. Left open, described honestly rather than banked as the easy fix it resembled.

### 4. The timeline-strip subsystem is unreachable in its entirety

`features/edl/timelineAutoInject.js` (517 lines, git-clean) has **no importers** — the only matches for its name outside its own header comment are in this report. The component it imports, `components/timeline/index.js`, has exactly two references: the dead injector, and `cutdiff/index.js:7`, which imports `createTimeline` and **never calls it**. `components/timeline/index.js:158` carries the same `total % fps` decomposition, and `:175`'s `Number(options.fps) > 0` guard admits a fractional rate happily — but no live path delivers one, or anything at all.

Deleting it is the user's call, not the loop's; an unused import in a dirty file is not something to sweep up unasked.

### Heuristics added

**1. A carried backlog item is a claim about the code made at a past commit, and claims rot.** Three of four items surveyed here were stale — one pointed at a file that does not exist, two at code nothing reaches. The still-open list had been treated as a work queue when it is really a set of hypotheses. Re-verify an item before spending an iteration on it; that verification cost minutes and saved the iteration.

**2. Reachability is the first question, not the last.** Every item surveyed was the *same* rate defect by shape, so severity of the math distinguished nothing between them. What distinguished them was whether any caller could arrive: two dead, one unreachable-by-default, one real-but-needs-plumbing. Ranking a backlog of same-shaped defects by how bad the arithmetic looks will rank it almost randomly.

**3. An iteration that changes no code is not a failed iteration** — provided it changes what the next one will do. This one shortened the queue by three and stopped the aceslook item being fixed in the wrong place.

### Still open (revised)

- **`_refineSourceOut`** — highest priority once it lands in HEAD; it no-ops rather than degrades.
- The three other `_matchEventByVisualWave` call sites, currently in-tree only.
- **A test that imports `trlconf/index.js` at all.** Still the highest-value item in the whole list: the it16 rate fix is backed by reasoning and a diff, by no machine.
- `modules/amf_convert.js` — three private TC helpers, `framesToSec` at `:4342`, `ensureComp` at `:4740`; generated ExtendScript, so rates must be threaded via `JOB`.
- `aaf_wasm.js` outside `assertParseResult`; `prproj.js:465`.
- `aceslook` TC overlay — needs a clip-rate source before the hardcoded 24 can be fixed.
- The untracked `tests-js/timecodeFuzz.test.mjs` + `electron/native/seekModel.js` pair (must land together).
- ~~`features/edl/filters.js`~~ — does not exist. ~~`timelineAutoInject.js:53`~~, ~~`filters_common.js`~~ — dead code, documented above.

---

## 21:00 run — iteration 1 · what a non-technical user sees when things break

**Scope.** Every path that puts failure text in front of a human: `ui.js`
`showError()` (the main banner), the three separate `_showToast` implementations
(`render_queue.js:1420`, `auth/login-ui.js:741`, `features/platelink2/index.js:1398`),
and `core/shotWorkItems.js:292`'s `window._showToast`.

**Finding 1 — a live humanizer existed and was not in git.**
`src/scripts/core/friendlyError.js` was untracked while being loaded by
`index.html:13` as a module script and called from five places. Any audit run
against HEAD would conclude the app has no error humanizer at all; the running
app has one. This is a general hazard in this tree, which carries ~690 dirty and
untracked files: **HEAD is not the app.** Now committed (`887b161`).

**Finding 2 — six error classes reached users as raw exception text.**
Measured, not estimated: `friendlyError()` was run over a 23-string corpus of
error text the app actually produces. Ten of 23 classified; the rest passed
through, of which six were genuinely technical rather than already-friendly.
All six are now classified. Detail and the rationale for each rule's placement
are in the backlog entry and in the commit message.

**Finding 3 — rule ordering in this module is silently load-bearing.**
First match wins, so a broad rule above a precise one swallows it with no
symptom at the call site. Three real collisions exist today:

- EBUSY vs EACCES — both match a locked file; the fixes are *close it in
  Resolve* and *grant Full Disk Access*, and giving the wrong one wastes a
  session.
- The WASM rule vs the generic programming-error rule, which matches
  "out of memory" and advises restarting the app. The memory is held by other
  open decoders; restarting to reclaim it is a much larger hammer than needed.
- The encode rule vs the decode rule. Deliberately kept narrow: a bare
  `ffmpeg exited with code 1` names neither end, and guessing "check your
  output folder" sends the user away from the input media that is broken.

Each pair is now pinned by a test in `tests-js/friendlyErrorRules.test.mjs`, so
a future reorder fails loudly instead of degrading advice quietly.

**Finding 4 — two quality invariants were unenforced and now are.** No
classified message may leak jargon (`ENOENT`, `RuntimeError`, `stderr`, …) into
title/message/hint; and every classified failure must offer exactly one next
step short enough for a toast (<170 chars). Both hold across the full rule table.

**Non-finding — pass-through is correct and worth defending.** The module
declines to rewrite text it doesn't recognise. That protects messages the app
already words well ("Scan a VFX folder first.", "Open the Cut Diff tab, then
retry"), which are better than any generic rule. An always-override design would
have been a regression. Guarded by test.

**Open.** `render_queue.js`'s private `_parseError` still returns `null` on a
miss instead of delegating to `friendlyText`. Fixing it needs the
reconstructed-blob staging technique — the file carries unrelated pending user
changes — so it is deferred rather than dropped.

### 21:00 run — iteration 2 · what a non-English user reads when things break

**Finding 1 — every failure message was English-only, in all 6 non-English
locales.** Not a gap in the dictionary: a structural one. `i18n.js` translates by
walking the DOM and matching text against a dictionary, but `friendlyError.js`
assembles its text in JS and hands the renderer a finished string. 0 of 50
user-facing strings were in the dictionary. Fixed by translating at source
(`1b2fdf1`).

**Finding 2 — the fix that suggests itself would have failed silently.**
Adding the 50 strings to the dictionary and relying on the observer looks
correct and is not: `friendlyText()` concatenates `message + ' ' + hint`, and the
observer would have called `toEnglishKey()` on that concatenation, which is not a
key. The symptom would have been 300 translations in the repo, a green test
suite, and English errors in production. Worth recording as a pattern: *a
translation layer that keys on rendered text is defeated by any string built
after the last dictionary lookup.*

**Finding 3 — the coupling between the two files is invisible.** Anyone adding a
rule to `friendlyError.js` sees 46 tests pass and has no signal that six locales
just lost coverage. `tests-js/errorI18n.test.mjs` closes this. It parses both
files as text — `i18n.js` cannot be imported in Node, it touches `window` at
load, and the literal is what we want to check anyway rather than whatever a
running app merged — and asserts: full coverage per locale; no translation
byte-identical to its English (the signature of a copy-paste stub); identical key
sets across all six; no orphaned entries left behind after a reword; that
`ERROR_DICT` is merged *before* `KEY_SET` is built, since merging after would
leave the entries present in the file but dead at runtime; that `friendlyError.js`
reaches i18n via the global and not an import; and a 170-char toast budget, which
Thai and Filipino run closest to.

The test also guards itself: if a refactor changed how rules are written, the
source-scanning regexes would find nothing and every coverage assertion would
pass vacuously, so there is an assertion that the scan found ≥45 strings and
one of each shape. **Negative-tested:** adding an untranslated rule breaks
exactly the six coverage tests and nothing else.

**Non-finding — the observer does catch banner text.** Worth writing down since
it was checked and is counter-intuitive: the MutationObserver watches
`childList` but **not** `characterData`. `showError()` assigns `el.textContent`,
which *replaces* the child text node rather than mutating it, so it fires
`childList` and is caught. Assigning to a text node's `.data` anywhere would not
be. Also confirmed `toEnglishKey()` does a reverse lookup, so already-translated
text maps back to its English key — round-tripping is safe and there is no
double-translation risk from translating at source.

**Open item — pass-through messages are still English.** `friendlyError` is
conservative by design: text it does not classify is returned unchanged, which
is right, because the app already writes good messages at those call sites. But
those messages — `"Scan a VFX folder first."`, `"Load a proxy video file in the
tab, then retry"`, `"Open the Cut Diff tab, then retry"`, `"Ensure shots/markers
are set in the tab, then retry"` — are **also absent from the dictionary**
(verified, not assumed). They do reach the DOM, so unlike the classified errors
they are fixable by dictionary entries alone. Scattered across call sites rather
than collected in one table, so extracting them is its own pass.

**Still open from iteration 1.** `friendlyError.js` and `friendlyError.test.mjs`
were uncommitted in-flight user work that this loop committed in `887b161`. Say
the word and they come back out with `git rm --cached`.

## 21:00 run — iteration 3 · a display path that displayed nothing

**Finding 1 — `showError()` has been a no-op for the life of the repository.**
Severity: this is the highest-impact defect found in three loop runs. The function
guards on an element that has never existed, in any page or any commit, so all 66
call sites in `src/scripts` produce nothing. Confirmed by absence in source, in
the build output, in runtime assignment, in DOM injection, and in
`git log --all -S'id="errors"'`. A user whose export is refused sees an app that
appears to have ignored the click.

The instructive part is *why it survived*. The code is not obviously wrong — it
looks like defensive programming, and `if (!el) return;` is the idiom you write
when an element is optional. Nothing logs, nothing throws, and the failure mode is
literally invisible. Nobody was ever going to notice this from the code; it took
asking a different question — *does this output reach the DOM at all?* — for a
reason unrelated to the bug.

**Reachability is the first question, not the last.** Third time this heuristic
has paid out, and the largest by far. The plan was to add dictionary entries; the
check that would have validated the plan invalidated the premise instead.

**Finding 2 — the fix that looks right is wrong here.** Adding
`<div id="errors">` to `index.html` fixes the desktop renderer and leaves the
extension target and both tool pages exactly as broken, because they do not share
that file. This is the same shape as iteration 2's trap (the obvious fix silently
does nothing) in a different subsystem, and it is worth naming as a pattern:
**in a one-source/two-target renderer, any fix expressed in `index.html` is a fix
to one host.** Self-mounting from the module that needs it is target-agnostic.

**Finding 3 — a unit test would not have caught this and will not catch it
again.** `errorBanner.test.mjs` passes completely with `ui.js` never importing the
module. So one test reads `src/scripts/ui.js` and asserts the wiring: that
`showError` calls the banner, that no live `#errors` lookup has returned, and that
the import is present. Comments are stripped first, since the replaced code is
quoted in a comment as documentation.

**Newly measured, still open (from the reachability table built for the abandoned
translation sweep):**

1. `setStatus` in `modules/amf_convert.js:4988` and `:5175` writes
   `STATE.statusText.text`, not the DOM. The i18n observer can never see those
   strings; they need a translation call at the assignment, not a dictionary entry.
2. `src/tools/bwav/*` and `src/tools/preflight/*` do not load `modules/i18n.js` at
   all. Every string on those pages is English in all seven languages.
3. `bwav/app.html` uses a *different* i18n system keyed on attributes
   (`data-i18n="status.ready"`). **The app has two unrelated i18n
   implementations**, and work on one does not reach the other.
4. `window._pmShowToast` and `window._pfxToast` are read by
   `render_queue.js:1426` but assigned nowhere in `src/`, so the inline fallback
   div is always the path taken. Same species as this iteration's finding — a
   preferred path that does not exist — though here the fallback saves it.
5. Four `_showToast` implementations (`render_queue.js:1420`,
   `auth/login-ui.js:741`, `features/platelink2/index.js:1398`,
   `core/shotWorkItems.js:292`) with no shared notifier between them.

**Still open from iteration 1.** `friendlyError.js` and `friendlyError.test.mjs`
were uncommitted in-flight user work that this loop committed in `887b161`. Say
the word and they come back out with `git rm --cached`.

## 21:00 run — iteration 4 · what a fix reveals

**Finding 1 — a repair can promote a latent defect to a visible one.** Iteration 3
restored a display path; 17 of the 70 messages flowing through it were raw
exception text. Neither change was wrong, but the pair had to ship together, and
the second was only discoverable by asking what the first had made visible.
Generalised: **after restoring any output path, audit what that path carries.**
The value of the content was irrelevant while nothing rendered it.

Measured shape of the 70 call sites: 17 pass raw `err.message`, 53 pass
hand-written prose. The 53 are why a blanket rewrite had to be conservative
rather than clever.

**Finding 2 — the boundary is the only place a rule of this kind holds.** Fixing
17 call sites is a fix with an expiry date; the eighteenth is written next week.
The rewrite belongs where the text meets the screen, which also covers
`window.pfxShowErrorBanner` and any future caller. This is the same lesson as
iteration 3's self-mounting banner in a different guise: **prefer the chokepoint
to the enumeration.**

**Finding 3 — `friendlyText('')` returns "Something went wrong."** An empty
message is the hide signal for every caller of the banner. Composing the two
without a guard means *clearing* an error displays one. Caught by checking the
falsy cases before wiring anything, not by a test written afterwards. Now pinned.

**Finding 4 — self-matching rules make idempotence non-obvious.** Several rules
produce output containing their own trigger phrase ("disk is full", and by
inspection the timeout and network rules are close to it). It happens to be
stable today because the second pass reproduces the same message and hint
verbatim, but that is a property of the current wording, not of the design. A
future rule whose message reads naturally and re-matches differently would
double-append silently. The idempotence test is therefore a guard on
`friendlyError.js`'s wording as much as on `errorBanner.js`.

**Carried forward unchanged from iteration 3:** the two-i18n-implementations
finding, the `setStatus`-writes-to-STATE finding, the tool pages that never load
`modules/i18n.js`, the phantom `window._pmShowToast`, and the four unrelated
`_showToast` implementations. Also still open: the `git rm --cached` offer for
`friendlyError.js` and `friendlyError.test.mjs`.

## 21:00 run — iteration 5 · translations nobody can select

**Finding 1 — a third phantom element, and the pattern is now a rule.**
`localeSelect` is read in two files and defined in none, exactly as `#errors`
was in iteration 3. All three share a shape: **a read against an element that
was never created, in code whose failure mode is silence.** `getElementById`
returning null is indistinguishable from a feature being off, so nothing ever
reports it. Recommended standing check: any `getElementById`/`querySelector`
whose id appears in no HTML file in the repo is a defect, and it is cheap to
grep for. That sweep has not been run yet across the whole tree — it is the
single highest-value open item on this list.

**Finding 2 — the previous audit entry was wrong, and wrong in the expensive
direction.** It claimed the tool pages had no i18n. They have three separate
i18n implementations between them (host: English-keyed dictionary + observer;
bwav: `data-i18n` attributes; preflight: per-locale JSON config files), and
~148K of translated preflight content that has never been rendered. Acting on
the entry as written would have meant *writing new translations* on top of
translations that already existed. **A claim about what the app lacks rots the
same way a claim about what it contains does** — that heuristic was recorded in
an earlier run and has now cost, and then saved, real work.

**Finding 3 — Preflight is pinned to English by a default that nothing can
override.** `app.js:398` sets `settings.locale = "en"` when unset; the only
writer is the change handler on the element that does not exist. Twelve
`checks.i18n.*` / `requirements.i18n.*` files plus six `ui_strings.*` files are
unreachable. Wiring is deferred, not dismissed: the existing switch path calls
`location.reload()` and `state.files` is not persisted.

**Finding 4 — `zh-TW` is declared supported by BWAV and has no dictionary.**
`SUPPORTED_LOCALES` at `bwav/app.js:651` lists `zh-TW`, `normalizeLocale` maps
any `zh*` to it, and `I18N` has entries only for `en/ja/ko/id/th`. Today `t()`
falls back to `I18N.en`, so a Taiwanese user gets English rather than raw keys —
correct by accident of the fallback, not by design. Now that the host can
actually send `zh-TW`, this path runs for the first time. Not fixed here:
supplying ~92 Chinese strings is authoring, not repair.

**Finding 5 — measured, still open.** The four `_showToast` implementations and
the phantom `window._pmShowToast` from iteration 3 remain. `setStatus` in
`modules/amf_convert.js:4988`/`:5175` still writes `STATE.statusText.text`
rather than the DOM, so the observer cannot see it — same family as this
iteration's finding: a string that exists, is correct, and reaches nobody.

**Still open from earlier runs:** the `git rm --cached` offer for
`friendlyError.js` / `friendlyError.test.mjs`.

---

## Iteration 6 — phantom element lookups, measured

**Correction to iteration 5's own ranking.** That audit recorded the phantom-id
sweep as "the single highest-value open item," on the reasoning that any
`getElementById` whose id appears in no HTML file is a defect. Having run it:
the premise is right and the ranking was wrong. There are 311 such ids across
440 lookup sites, and the breakdown is **0 crash / 6 fallback / 434 silent**.
Nothing in that population is reaching a user as a broken control today; the
three that were are the three already fixed by hand in iterations 3–5.

**Finding 1 — the population is drift, not defects.** Sampled desktop-facing
entries all have a working alternate beside them: `#aboutVersion` (superseded by
`versionBtn` + `setBtn`), `#loadingMsg` (superseded by `_parseProgressShow`),
`#eventTable`, and six `main-*` panel ids read against the thirteen that
`src/index.html` actually defines. Some are explicitly intentional —
`bwav/popup.js` carries `// (Mode UI removed)` next to its `#modeSelect` read,
and that file is the extension popup, not the desktop pane. **A sweep that
treats every phantom as a defect generates busywork**, which is why the baseline
records them as known rather than as a to-do list.

**Finding 2 — the scan was under-reporting until a comment was disqualified.**
`errorBanner.js:11` reads `No element with id="errors" has ever existed`. The
scan counted that comment as a definition, and `#errors` — iteration 3's entire
premise — dropped out of the results. Three other ids were hidden identically.
This is the sharpest instance yet of the recurring lesson: **a test that greps
must prove its grep works.** The measurement before the fix (310 ids / 437
sites) was wrong in the direction that makes a guard weaker, and nothing about
running it would have said so.

**Finding 3 — a unit test can cover a branch that never runs.**
`classify`'s two-line-dereference path required the assignment to end at `=`.
That holds for `$("#x")` and fails for `document.getElementById("x")`, where the
receiver sits between. The unit test passed; the branch was dead against every
real file in the tree. It was caught by injecting the defect into `src/` and
watching the gate *not* fire. **Negative-verification found what the test
suite could not**, which is the argument for doing it on every gate rather than
on the ones that look risky.

**Finding 4 — the baseline needs an anti-rot clause, and it has one.** A frozen
list of known-bad ids decays exactly the way iteration 5's stale audit entry
did: silently, while still being read as current. The contract test therefore
fails not only on a new phantom but on any baseline entry whose id now exists,
so a fix cannot be made without the record of it being updated in the same
commit.

**Still open from earlier runs:** the Preflight reload-free re-localisation, the
missing `zh-TW` BWAV dictionary (~92 strings — authoring, not repair), the four
unconsolidated `_showToast` implementations, `setStatus` in
`modules/amf_convert.js:4988`/`:5175` writing `STATE.statusText.text` instead of
the DOM, and the `git rm --cached` offer for `friendlyError.js` /
`friendlyError.test.mjs`.

---

## Iteration 7 — 2026-07-26 16:30 +0700

### Finding 7.1 — the shipped app was 2.1 GB, and 1.57 GB of it was scratch (fixed, `9f9dc4b`)

`build.files` in `package.json` globbed `electron/**/*` with only `.DS_Store` and
`__pycache__` excluded. That pulled `electron/native/PFXNativeMediaEngine/.build`
(1.4 GB of Swift Package Manager intermediates, including a `.dSYM` and a full
`checkouts/` tree) and `electron/imf/metal-htj2k/vectors` (169 MB of HTJ2K
conformance vectors) into `app.asar`, which measured 1,651,714,109 bytes against
a 36 MB renderer.

Two negations fixed it. `app.asar` is now 35,992,338 bytes and the `.app` is
488 MB. Verified after packaging that all eight `asarUnpack` patterns still
resolve to real files and that neither excluded tree survives anywhere under
`Contents/Resources`.

**Severity is about reach, not risk.** Nothing was broken and nothing crashed —
which is precisely why it lasted. An oversized download is a defect that is
invisible from inside the running app and only visible to the person waiting for
it to arrive.

### Finding 7.2 — a leading-dot directory hides from review, not from a glob

`.build` does not appear in `ls electron/native/`. `du -sh electron` reports
1.6 GB, but nothing in the normal read-code-and-review loop surfaces the split
between product and scratch. The general form: **`**/*` includes what you have
forgotten you have.** Any repo that builds native code beside its source will
accumulate this, and the accumulation is silent and monotonic.

No gate is proposed for it yet. A package-size assertion is the obvious move,
but a threshold picked today would either be so loose it never fires or so tight
it fires on the next legitimately-added binary, and a gate that gets raised
every time it trips is a gate that has been trained not to work. Recording the
shape of the problem is worth more right now than an arbitrary number. Carried
as open.

### Finding 7.3 — "does the app still launch" would have passed a wrong exclusion

Worth stating because it was the tempting shortcut. Launching the packaged app
exercises the renderer and the main process. It does not exercise R3D decode,
the AVFoundation bridge, or the Metal HTJ2K path — all of which load their
binaries lazily, on first use of a feature. An exclusion that removed one of
those would have produced a clean launch and a failure weeks later, in the
field, on a specific file format.

The check that actually holds is reading the resolution logic at each load site
(`pfx_native_engine.js:15`, `imf_metal_htj2k_backend.js:26`) and then asserting
against the packaged tree that each resolved path still exists. That is a
statement about all three paths, made without running any of them. This is the
same principle as the negative-verification rule from iteration 6, applied to
packaging: **a check must be able to fail for the reason you care about.**

**Still open from earlier runs:** the Preflight reload-free re-localisation, the
missing `zh-TW` BWAV dictionary (~92 strings — authoring, not repair), the four
unconsolidated `_showToast` implementations, `setStatus` in
`modules/amf_convert.js:4988`/`:5175` writing `STATE.statusText.text` instead of
the DOM, a package-size gate with a defensible threshold (7.2), and the
`git rm --cached` offer for `friendlyError.js` / `friendlyError.test.mjs`.

---

## Iteration 8 findings (2026-07-26 17:12)

### 8.1 — Third confirmed instance of the phantom-element species, now fixed
`src/tools/preflight/app/app.js` bound its language picker to
`qs("localeSelect")`, an id `app/index.html` has never contained. Eighteen
locale config files — six complete language sets, roughly 148K of translated
check text — were packaged into every build and unreachable. Fixed in `4c63a5d`
by taking the language from the title bar's existing `pfx:lang` broadcast
instead of from a control that does not exist.

Notable: this case was already written down. It appears by name in the header of
`tests-js/domContract.test.mjs` and `tests-js/lib/domIds.mjs` as one of the three
examples that motivated the phantom-id contract in iteration 6. The contract
stopped a *fourth* instance from being added; it did not fix the three known
ones, and was never meant to. Worth being clear about the division: a baseline
freezes the debt, it does not pay it.

### 8.2 — A test that fails on the comment explaining the fix
The new gates search `app.js` for `location.reload(` and `localeSelect`. Both
failed on first run — because the comments explaining *why* those two things are
gone contain those strings.

This is the exact mirror of the trap recorded in `tests-js/lib/domIds.mjs`, where
a comment reading `id="errors"` convinced the scanner the element existed and the
documentation of a bug registered as its fix. Here the documentation of a fix
registered as the bug. Same root cause, opposite direction: **a source grep does
not distinguish code from prose, and both directions of that confusion are
silent.** The scan now strips whole-line comments, matching `domIds.mjs`'s
`COMMENT_LINE`. Any future gate written against raw source in this repo should
do the same.

### 8.3 — A negative-verification that verified nothing
The ordering gate — `relocalize` must load the new config *before* mutating
`state.config`, so a failed load leaves the pane in its old language rather than
half-translated — was negative-verified by injecting a `state.config = {}`
assignment. The gate did not fire, and the first reading was "the gate is
broken."

It was not. The injection had been placed *after* the `await loadConfig`, so it
was not the defect the gate describes; the correct injection (assigning before
the load) fired it immediately. The lesson is narrow and worth keeping:
**negative verification only proves something if the injected defect is actually
the one the gate claims to catch.** An injection that fails to trip a gate is
ambiguous — it means either the gate is broken or the injection is wrong, and
those must be told apart before either conclusion is recorded.

### 8.4 — Deliberate non-decision: no second language control
Adding the missing `#localeSelect` would have been the smaller diff and is what
the dead code asked for. Declined. The app has one language control in the title
bar; a per-pane picker is a second place for the answer to differ from itself,
and a user who set the app to Thai has already stated their preference. The
per-pane control is only justified if a pane can be usefully read in a different
language from its host, which is not true here.

**Still open from earlier runs:** the missing `zh-TW` BWAV dictionary (~92
strings — authoring, not repair), the four unconsolidated `_showToast`
implementations, `setStatus` in `modules/amf_convert.js:4988`/`:5175` writing
`STATE.statusText.text` instead of the DOM, `window._pmShowToast` /
`window._pfxToast` read by `render_queue.js:1426` and assigned nowhere, a
package-size gate with a defensible threshold (7.2), and the `git rm --cached`
offer for `friendlyError.js` / `friendlyError.test.mjs`.

## Iteration 9 findings (2026-07-26 18:00)

### 9.1 — The phantom-*global*: five names, zero writers
Iteration 6 measured the phantom-*element* species: 311 ids read at 440 sites,
434 of them silent. This iteration found the same defect one level up the stack.

`window.<name>` read inside a feature-detection chain —
`if (typeof window.foo === 'function') { … }` — where nothing in `src/` or
`electron/` ever assigns `window.foo`. It fails identically to the phantom
element: `typeof undefined` is `'undefined'`, the branch is skipped, no error is
raised, and the code reads as defensive rather than dead.

Five instances, all toast-shaped, all with zero writers before this iteration:

| Read at | Name | Had a working fallback? |
|---|---|---|
| `render_queue.js:1426` | `_pmShowToast`, `_pfxToast` | yes — local `_showToast` |
| `core/shotWorkItems.js:291`, `:296` | `pfxToast`, `_showToast` | **no** |
| `features/cutdiff/index.js` | `showToast` | yes — `_cdSetProjectStatus` |

Ranked by what it cost the user, not by count: `shotWorkItems` is the only one
with *no* surviving branch. Creating a VFX marker fell through to
`console.info('[SWI]', msg)`. The user pressed a button and the app said nothing
— in a workflow where the whole point of the button is to confirm a marker now
exists. The other two spoke via their fallback; their preferred path was merely
dead code, which is a maintenance cost, not a user-facing one.

### 9.2 — The phantom-*CSS-class*: a class is an id wearing a different hat
`modules/amf_convert.js __toast()` builds a `<div class="mps-toast">`, appends
it, and toggles `.show`. Neither `.mps-toast` nor `#mpsToast` appears in any
stylesheet under `src/`. So ten messages — including "Exported Excel (V5
Template)." and raw upload errors — appended unstyled text to the bottom of a
6,500-line document, where removing `.show` did nothing because adding it had
done nothing.

The generalisation worth keeping: **the phantom species is not about
`getElementById`. It is about any cross-file name resolved at runtime with no
build-time check** — an element id, a global, a CSS class, a data attribute. Each
one needs its own gate, because each one fails in its own silence.

### 9.3 — Asynchronous dismissal makes `while (children.length > N)` non-terminating
Caught by the new test before it shipped, and the most valuable thing this
iteration produced.

The first draft of the stack trim was the obvious loop:

```js
while (host.children.length > MAX_VISIBLE) dismiss(host.firstElementChild);
```

`dismiss()` is deliberately asynchronous — it adds `.is-leaving` and schedules
`toast.remove()` 220ms later so the leave transition can run. So the node it just
dismissed is *still a child* on the next iteration, `children.length` never
drops, and the loop spins forever. The fifth toast of a session would have locked
the renderer — not degraded it, locked it, on the main thread, with no error in
the console.

The fix counts only nodes not already marked `_pfxGone`. The test that found it
is written so that if the defect returns it *hangs* rather than fails, and its
comment says so, because a hanging test is a clearer signal here than a red one.

**Method note:** the bug was not found by review. It was found by running the
test, which sat at zero output until it was killed. A test that hangs is
evidence, not a broken test — the first instinct was to suspect the harness.

### 9.4 — RETRACTION: `setStatus` in `modules/amf_convert.js` is not broken
Recorded in iteration 5 as newly-measured finding #1 and carried forward in the
"still open" list of iterations 6, 7 and 8. It is a false positive. Retracted.

The claim was that `setStatus` at `:4988` and `:5175` writes
`STATE.statusText.text` instead of the DOM, so the i18n observer can never see
those strings. Both lines are inside a template literal that *generates After
Effects ExtendScript*. `STATE.statusText` is a real ScriptUI `statictext` widget,
created at `:5109` and `:5311`. Setting `.text` on it is the correct and only way
to update a ScriptUI label. There is no DOM in that program, no i18n observer,
and nothing to fix.

The generalisable error: **a grep for a suspicious pattern cannot tell which
language it is reading.** `.text = ` looks like the same mistake in JavaScript
and in ExtendScript-inside-a-string; only one of them is one. This is the same
class of error as 8.2 (a source grep cannot distinguish code from prose) — the
remedy there was stripping comments; the remedy here is checking what runtime the
matched line executes in before recording a finding. Both are cases of a scan
being trusted past the point where it still knows what it is looking at.

Three iterations of "still open" lists repeated this without re-checking it.
Carried findings need re-verification, not just re-typing.

### 9.5 — Two gates, both negative-verified, one with a control
`tests-js/toastContract.test.mjs`, 15 tests.

*Gate 1* scans every `.js` under `src/` for `window.<something>toast<something>`
reads and for `window.X =` / `globalThis.X =` writes, and fails on any read with
no writer. Negative-verified by adding a read of `window.__pfxFakeToast` — fired
immediately, naming that exact global. Then a **control**: the same read placed
inside a `//` comment, which must *not* fire. It did not. That control exists
because 8.2 recorded a gate that matched its own documentation; a comment-only
control is now the cheap way to prove the stripper works.

*Gate 2* asserts every class the module emits is styled in `main.css` **and**
that every class listed is still emitted by the module. The second half is the
one that matters over time: without it the list rots into a record of what the
code used to do. It caught its own bug during authoring — the needle
`"'pfx-toast--' + kind"` never matched because the module writes
`'pfx-toast pfx-toast--' + kind`.

### 9.6 — Deliberate non-decision: four local toasts left alone
`auth/login-ui.js:741` and `features/platelink2/index.js:1398` each have a
self-contained `_showToast` with its own styled class (`.pfx-auth-toast`,
`.pl2-toast`). They work. Consolidating them would be a rewrite of working code
for uniformity's sake, and would put the login toast — which must render before
the main renderer's scripts are guaranteed loaded — behind a new dependency. The
scope here is *repair the broken paths*, and four working implementations are not
a broken path. They stay.

**Still open from earlier runs:** the missing `zh-TW` BWAV dictionary (~92
strings — authoring, not repair), `src/tools/bwav/*` and `src/tools/preflight/*`
not loading `modules/i18n.js`, the app's two unrelated i18n implementations, a
package-size gate with a defensible threshold (7.2), and the `git rm --cached`
offer for `friendlyError.js` / `friendlyError.test.mjs`. The `setStatus` entry is
retracted per 9.4 and does not carry forward. The `_pmShowToast` / `_pfxToast`
entry is closed by this iteration.

---

## Iteration 10 findings (2026-07-26 18:50)

### 10.1 — The *shadowed element*: the mirror image of the phantom, and worse

Nine iterations of this project have chased the phantom element — an id the code
reads that nothing defines. This iteration found its opposite, and it is the more
dangerous of the two.

`src/index.html` defined 18 ids twice, all `cd2x-insp-*`. `getElementById`
resolves first-in-document-order. The first copy was inside
`<div id="cd2x-inspector-stub" style="display:none">`, so all 18 lookups in
`features/cutdiff2/index.js` bound to a hidden element and the visible panel
never received a value.

Why this is worse than a phantom:

| | phantom | shadowed |
|---|---|---|
| lookup returns | `null` | a real, live `HTMLElement` |
| guard `if (!el) return` | fires | does not fire |
| writes go | nowhere | into a `display:none` subtree, successfully |
| looks like | a feature that is off | a feature that is on and has no data |

A phantom at least trips every null-guard in the codebase. A shadow trips none of
them. Every defensive check the author wrote passes, because there genuinely is
an element there — just not the one anybody meant.

**A duplicate kept "for compatibility" does not add a fallback. It shadows the
real one.** This is the generalisable lesson. The comment on the stub read
`stub kept for legacy DOM refs`, which is a reasonable-sounding intention that is
exactly backwards: DOM id resolution has no notion of "fall back to the other
one", no preference for visible over hidden, and no warning when the choice is
ambiguous. First wins, silently.

Note also which ids were *not* duplicated: `cd2x-insp-close`, `-event`, `-type`,
the three in the panel header. That is why the failure presented as "the panel
opens and the header fills in, then everything below is blank" — a symptom that
points a reader at the data, not at the markup. The partial correctness is what
made this survive.

### 10.2 — Zero-tolerance is available here, and that is worth something

The phantom gate needs a 311-entry frozen baseline, because most phantoms are
harmless drift and fixing them wholesale would be busywork with real regression
risk. The duplicate gate needs no baseline at all: after this fix there are **0
duplicated ids across all 11 checked-in HTML files**, and a duplicate in static
markup is never defensible.

That is only true because the scan is deliberately restricted to static HTML. An
id minted at runtime from a template literal may legitimately be produced once
per table row, so multiplicity there carries no information. Widening the scan to
JS would have forced a baseline and turned an unambiguous gate into a negotiable
one. The narrower gate is the stronger gate.

### 10.3 — Negative verification against the real defect, not a stand-in

Audit 8.3 established that a negative verification only proves something if the
injected defect is the one the gate claims to catch, placed where the gate
actually looks. This iteration had the luxury of not needing to inject anything:
the defect was in `HEAD`.

`git show HEAD:src/index.html` was restored in place and the suite run. Both
gates went red and enumerated all 18 ids. Restored, both went green. That is a
stronger control than any synthetic fixture, and it is available for free any
time the bug being fixed is one that shipped.

The in-test control document was kept anyway, so the gate still has a proof of
sensitivity that lives in the repo after `HEAD` moves on.

### 10.4 — A gate that takes 41 seconds to fail is a gate that gets skipped

The regression test's failure path ran for 41 seconds. Cause:
`assert.equal(document.getElementById('cd2x-inspector-stub'), null, …)`. On
failure Node renders a diff of the actual value, and rendering a linkedom element
renders its whole subtree. Comparing `el === null` to `true` instead: 17ms.

Worth stating as a rule, because it generalises past this file: **never pass a
DOM node as the actual value to a Node assertion.** Assert on a boolean, an id
string, or a count. Nobody reads a 48-line element dump anyway.

### 10.5 — Process failure: the reconstructed-blob rule was known and skipped

The first commit attempt swept 19 foreign hunks into the commit — the user's
uncommitted tab tooltips and tab-group labels — because `git commit --only`
re-stages from the working tree, and `src/index.html` was already dirty.

This is not a new lesson. Iteration 9 hit it, solved it, and recorded the remedy
in its own write-up: *"Five of the six tracked files carried pre-existing foreign
hunks; each was staged as a reconstructed blob."* One iteration later the same
file, the same trap, and the technique simply was not applied.

It was caught by reading `git show --stat` and seeing 62 insertions where 6 had
been written. Repaired via `reset --soft` + `hash-object -w` +
`update-index --cacheinfo`, with three confirmations afterwards: the staged diff
is one hunk, the 20 foreign hunks are uncommitted again, and the working-tree
file is byte-identical to its pre-repair state.

The remedy that failed was a *procedure to remember*. The remedy that worked was
a *check that catches it*: read `--stat` after every commit and confirm the line
counts match what you wrote. Audit 9.4 said carried findings need re-verification
rather than re-typing; this is the same shape one level up — a carried *technique*
needs a check, not a recollection.

### 10.6 — Measured, not yet fixed: 35 controls with no accessible name

A full accessible-name pass over the rendered `index.html`, using linkedom and a
proper name-resolution walk (aria-label → aria-labelledby → `label[for]` →
wrapping `<label>` → title → placeholder):

* **111 visible form controls, 35 with no accessible name**
* **503 visible buttons, 9 with no accessible name**

Mixed severity, and it should not be treated as 44 identical bugs:

* `pl2SelectAll` sits inside `<label title="Select / deselect all shots">`. A
  sighted user gets a tooltip; a screen reader gets nothing at all.
* `tlcFlatSrc` has an adjacent `<span class="tlc-opt-lbl">FILTER</span>` that is
  not associated with it.
* `imfCplSel` / `imfVersionSel` / `imfFpsSel` are partly self-describing through
  their option text.
* The range sliders — `pmScrub`, `imfVolSlider`, `imfSeek`, `pmQaSize`,
  `pmVidBrightSlider`, `pmSlyCmpMix`, `pfxVfxPlrSlider` — are visually obvious
  and completely invisible to a screen reader.

Candidate for iteration 11.

**A correction to how this number was reached.** The first pass at it was a
regex scan, and it reported 68 of 135 unnamed — roughly double the truth. It
missed that a **wrapping `<label>` names its control without `for=`**, which is
the dominant pattern in this codebase
(`<label>AR tolerance <input id="arTol"></label>`), and it counted `display:none`
file-picker proxies as visible controls. Audit 9.4's lesson — that a grep cannot
tell what it is reading — recurred inside a single iteration, one iteration after
being written down. The figures above are from the linkedom re-implementation and
supersede the regex ones entirely.

**Still open from earlier runs:** the missing `zh-TW` BWAV dictionary (~92
strings — authoring, not repair), `src/tools/bwav/*` and `src/tools/visionscope/*`
not loading `modules/i18n.js`, the app's two unrelated i18n implementations, a
package-size gate with a defensible threshold (7.2), the 44 unnamed controls
above (10.6), and the `git rm --cached` offer for `friendlyError.js` /
`friendlyError.test.mjs`.

## Iteration 11 findings (2026-07-26 19:32)

### 11.1 — Markup that looks like a label and is not

The phantom (iteration 9) and shadowed (iteration 10) species are both about
a lookup returning the wrong thing. This one is about markup that *reads* as
handled to anyone skimming it.

```html
<label class="pl2-sel-all-wrap" title="Select / deselect all shots">
  <input type="checkbox" id="pl2SelectAll">
</label>
```

There is a `<label>`. It wraps the input, which is the correct pattern and
genuinely does supply a name with no `for=` needed. There is even a
human-written description sitting right there. And the accessible name is
empty, because:

- a wrapping `<label>` names its control from its **text content**, and this
  one has none; and
- `title` names the element it is written on. On the label, it describes the
  label. It does not descend to the input.

Move the same string onto the input as `aria-label` and it works. The defect
and the fix are three inches apart in the file. What makes this species worth
naming is that the *presence* of correct-looking accessibility markup is what
stops a reviewer from checking whether it does anything.

**Detection rule:** a `<label>` whose text content is empty is not a label.
The gate treats it as absent, which is why the synthetic control in
`accessibleNames.test.mjs` includes exactly this shape.

### 11.2 — `opacity: 0` is not `display: none`, and the difference is the whole point

`#folderPicker` and `#filePicker` are styled:

```css
.filePickerHidden {
  position: fixed; left: -10000px; top: -10000px;
  width: 1px; height: 1px; opacity: 0; pointer-events: none;
}
```

This is the standard "hidden file input triggered by a real button" pattern
and it is fine — but it removes the control from *view*, not from the
accessibility tree. `display:none` and `visibility:hidden` prune the a11y
tree; off-screen positioning and `opacity:0` do not, and `pointer-events:none`
governs the mouse only, not the Tab key.

So these two inputs are reachable by keyboard and exposed to assistive tech,
announced as "file upload button" twice in a row with no way to tell which is
the folder and which is the files. The sighted user never encounters them at
all. **Visual hiding inverts who is affected — it does not reduce the count.**

### 11.3 — The visibility rule almost silently disabled the gate

The first version of the scan walked ancestors looking for `display:none`.
Result: **2 visible form controls, 0 unnamed.** The gate would have passed,
permanently, having examined almost nothing.

Cause: this app puts each tab in a panel that is inline `display:none` until
its tab is clicked. Walking up therefore classified nearly the whole
application as hidden. Restricting the check to the element's own inline style
gave the true figure of **82 visible controls in `src/index.html`, 25 unnamed**
— and 455 buttons, all of which turned out to be correctly named.

This is the same failure the `'the scan actually sees the tree'` guard exists
to catch, and it is the third iteration in a row where that guard mattered.
Here it would have caught it: `82 > 500` fails outright at the repo level. But
it was caught earlier, by the number simply looking absurd. **A scan reporting
a suspiciously clean result is a scan to distrust before celebrating.** The
orders-of-magnitude guard is now in this file too (`>= 8` files, `> 500`
controls).

Worth recording precisely because it cuts against iteration 10's lesson:
there, the narrower scan was the stronger gate. Here, narrowing the scan
by one plausible-sounding rule nearly eliminated it. The distinction is
whether the narrowing is *principled* (static HTML only — runtime ids may
legitimately repeat) or merely *convenient* (skip anything currently hidden).

### 11.4 — Correcting iteration 10's own numbers

Audit 10.6 reported **35 unnamed form controls and 9 unnamed buttons**. The
accurate figures, measured with the corrected visibility rule and the full
six-route name resolution, are **34 unnamed form controls across six files
(25 of them in `src/index.html`) and 0 unnamed buttons**.

The 9 "unnamed buttons" were false positives: buttons whose name comes from
their own text content, which the earlier pass did not treat as a naming
route. Every one of the 455 visible buttons in `src/index.html` is named.

Both figures in 10.6 came from a scan that had not been negative-verified.
**A measurement quoted in a report is a claim, and it needs the same
verification a gate does** — the number was carried forward into a plan for
the next iteration, which is exactly how a wrong figure becomes wrong work.

Also correcting the record: the commit message and appended text of `79ce72f`
state that **19** foreign hunks were swept into the aborted commit `2bbae9f`.
The accurate count is **20**. Left as a correction here rather than an amend,
since `79ce72f` is already in history.

### 11.5 — What this gate cannot see

Stated so the green tick is not read as more than it is:

- **Only static markup**, and only `<input>`, `<select>`, `<textarea>`,
  `<button>`. Controls constructed at runtime are invisible to it, as are
  `div`/`span` elements carrying `role="button"` — a pattern this codebase
  does use.
- **Only absence, never quality.** `aria-label="Slider 3"` passes. Whether a
  name is accurate and distinguishable is a review question, not a mechanical
  one. The 34 labels written in this iteration were each chosen against the
  surrounding markup or, in two cases, against the handler code — but the
  gate would not have objected to worse ones.
- **Not language.** The Thai VisionScope popup got a Thai label by inspection.
  Nothing checks that a control's name matches its page's language.
- **Not roles, focus order, contrast, or keyboard traps.** Naming is one
  requirement among several, and the only one closed here.

### Still open from earlier runs

- `zh-TW` is in bwav's `SUPPORTED_LOCALES` (`app.js:651`) with no `I18N`
  dictionary — ~92 Chinese strings. Authoring, not repair.
- `src/tools/bwav/*` and `src/tools/visionscope/*` load no i18n at all; the
  app carries two unrelated i18n implementations.
- A package-size gate with a defensible threshold (7.2), still deliberately
  deferred.
- `render_queue.js`'s private `_parseError` and whether its `return null`
  miss-path should delegate to `friendlyText`.
- `friendlyError.js` / `friendlyError.test.mjs` were in-flight uncommitted
  work that iteration 2 committed in `887b161`; still awaiting a decision on
  whether to `git rm --cached` them back out.

---

## Audit 12 — a defect species the existing gate is structurally blind to

### 12.1 The phantom-id-as-map-value

`tests-js/domContract.test.mjs` finds an id that does not exist by scanning
`getElementById('literal')` call sites. That is the right scan for the shape
it covers, and it is blind to this:

```js
const _tutModalMap = { …, trlconf: 'tconformTutorialModal', … };
const modal = document.getElementById(_tutModalMap[tabKey]);
if (!modal) return;
```

The id never appears next to `getElementById`. It arrives as a variable. The
scan sees `getElementById(<expression>)` and has nothing to check.

This is worth stating generally: **a contract gate keyed on a syntactic shape
covers exactly that shape.** Every layer of indirection between the literal
and the call is a hole. Table lookup is the common one here, but
`` `${kind}Modal` `` and `ids[i]` are the same hole. `modalIds.test.mjs`
closes the table-lookup case by checking the *literal* against the element
inventory regardless of how it is consumed — which is the more durable
framing, and the one to reach for next time.

### 12.2 "No static id" is not the same as "does not exist"

The first reading of the probe returned six unresolved `*Modal` literals. Five
of them were real modals built at runtime with an explicit `el.id = 'name'`.
Reporting those five would have been a gate that is wrong the day it lands.

Checking all six individually before drawing the conclusion is what made the
gate shippable. The rule that survived — *static id **or** creation site* —
is a narrowing that distinguishes the two states the gate exists to tell
apart, not one chosen to make the number come out zero. Iteration 11 hit the
identical fork with `opacity:0` controls. It is now twice; treat the question
"does this exclusion answer the gate's question, or just quiet it?" as
standing procedure whenever a first reading is trimmed.

### 12.3 Two negative results, recorded so nobody re-runs them

Audit 11.5 predicted two accessibility species. Neither exists here.

- **Click targets unreachable by Tab: 0.** 144 ids receive a JS click handler;
  32 resolve against static markup; every one is natively focusable or carries
  `tabindex="0"`.
- **`role="button"` without an Enter/Space handler: 0.** All 6 (four
  `.fun-launcher-item`, two bwav `#dropzone`) have `tabindex="0"` *and* a
  keydown handler. `ui.js:18377` is the model.

A negative result costs the same to produce as a positive one and is worth
the same words in the report. Without this section the next iteration pays
for the search again and finds the same nothing.

### 12.4 A static scan of `[onclick]` measures almost nothing in this codebase

The first reachability probe read `[onclick]` and `[role=button]` out of the
markup and returned zero offenders. Zero, because static `onclick` is
essentially unused here — handlers attach via `addEventListener` (86
`getElementById(…).addEventListener('click'`, 206 `$('#…')`).

The standing rule caught it: *a scan reporting a suspiciously clean result is
a scan to distrust before celebrating.* The rewrite cross-referenced JS
binding sites against HTML focusability, and its zero (12.3) is a real one.
The tell is not the number — it is whether the denominator was ever plausible.

### 12.5 One control, two handlers, two sources of truth

The underlying defect is not the typo. It is that one button has two
listeners, each with its own copy of the same mapping, and **nothing detects
that the copies disagree**. The typo is what made it visible; a table that had
agreed on the *wrong existing* id would have looked identical from outside and
passed every gate in the repo, including the new one.

`modalIds.test.mjs` can prove a name resolves to an element. It cannot prove
it resolves to the *right* element — the assertion pinning `trlconf` to
`tlcTutorialModal` is a human reading, hardcoded. Duplicated state read by two
handlers on one control is worth its own sweep.

### 12.6 What the new gate cannot see

- **Only names ending in `Modal`.** The suffix is what makes a bare string
  unambiguously an element reference; widening the net drowns it in prose.
  Ids reached through a variable that are *not* `*Modal` remain uncovered.
- **Not runtime-assembled ids.** `` `${kind}TutorialModal` `` is invisible.
- **Not correctness of the target** — see 12.5.
- **Not reachability.** `#tlcTutorialModal` existed, was authored in seven
  languages, and was unreachable from the header for however long this has
  shipped. Nothing in the repo measures "authored content the UI has no path
  to". That is the most interesting open question this iteration raised.

### 12.7 Follow-ups this iteration created

- The global How to Use button **silently does nothing** on `bwav`,
  `preflight`, `renderq` and `home`: neither table has an entry, and no
  tutorial modal exists for them. Pressing help and getting nothing is a
  worse experience than the button being absent. Either author the four
  tutorials or hide the button on those tabs.
- The global button shows `#tlcTutorialModal` in static English rather than
  the user's stored tutorial language (`_renderTlcTutorial` is closure-private
  and `tl_convert/index.js` exports nothing on `window`).
- Consolidating the duplicate `#btnTutorial` handler pair.
- A tab-name consistency sweep. `trlconf` was called "Timeline Conform" in one
  place and "Trailers Conform" in three; the feature inside it is "Timeline
  Convert". Whether the other ten tabs are consistent is unmeasured.

## Audit 13

### 13.1 A new species: unreachable authored content

Every defect this loop has found so far has been something *wrong*: an id that
names nothing, a control with no name, a handler bound to the wrong copy of a
shadowed element. This one is different. Nothing about
`#playerTransportTutorialModal` is wrong. The markup is valid. The wiring
function is correct. The close handling works. The eight demo buttons would
respond if anyone clicked them.

There is simply no line of code anywhere that makes it visible.

That is the signature of the species: **the defect is the absence of a line**,
and absence is what code review is worst at seeing. A reviewer reads
`_wirePlayerTransportDeepDive()` and sees a function that does its job. A
reviewer reads

    if (modalId === 'playerTransportTutorialModal') _wirePlayerTransportDeepDive();

and sees a call site. Both readings are correct in isolation. What is invisible
is that the set of values `modalId` can hold never contains that string —
information that lives in a different function, in a table twelve entries long,
and only exists as a fact about the *union* of two files.

It is worth naming what it cost: not a crash, not a wrong answer, but 133 lines
of somebody's careful teaching work that no user has ever seen.

### 13.2 The reverse-direction audit

Iteration 12's gate asks: *does every id the code references actually exist?*
It caught `tconformTutorialModal` — a name with no element.

Iteration 13 asks the inverse: *does every element we authored have code that
references it?* Same two sets — authored ids, referenced ids — and merely
reading the difference in the other direction. That took one probe to write and
found a defect the forward direction is structurally incapable of seeing, because
in the forward direction `playerTransportTutorialModal` is perfectly resolved:
it appears in JS, and the element exists. Both checks pass. The relationship
between them is what is broken.

Generalisable: **any gate that checks a mapping in one direction has a blind
spot exactly the size of the other direction.** Worth walking the list of
existing gates and asking, of each, what its inverse would find.

### 13.3 "Mentioned somewhere" is far too weak a proxy for "reachable"

The first probe of this iteration asked the obvious question — for every authored
overlay that starts hidden, is it mentioned anywhere in JS or HTML? It found
**22 authored hidden overlays and zero orphans.**

Applying the standing rule (a scan reporting a suspiciously clean result is a
scan to distrust before celebrating), the denominator was checked: 18
`id="*Modal"` in HTML, 16 with inline `display:none`, 9 `pfx-tutorial-modal`
lines. The denominator is genuinely plausible. This is a real negative result,
not a broken scan — **and it was still useless**, because the very modal that is
unreachable was "mentioned" five times.

Recorded here so nobody re-runs it. The lesson is about proxy quality: *mentioned
in the source* and *reachable by a user* are separated by every dead branch,
every self-lookup and every close-only handler in the codebase. The gate that
shipped tests routing instead, which is a claim about what the code can actually
dispatch.

### 13.4 A clipped `sed` range produces a false positive

While comparing the two router tables, `sed -n '11908,11930p'` cut off the last
entries and made `cutdiff2` look absent from `_tutModalMap`. Re-read at
`11908,11932` — it is there, both tables agree, no defect.

Nothing about the output announced that it was truncated. A range read is a
silent claim about where a construct ends, and that claim was wrong. When the
question is *does this table contain X*, grep the table for X; do not eyeball a
range you chose by guessing.

### 13.5 Dead code that reads as live code

Both dead guards are written in the idiom of working code:

    if (modalId === 'playerTransportTutorialModal') _wirePlayerTransportDeepDive();

Nothing distinguishes this from the four live lines beside it. There is no
compiler that will say "this comparison is never true", because the values of
`modalId` come from a table lookup and no type system in play here tracks that.

This is the same shape as the `if (!modal) return` from iteration 12: a
construct whose purpose is to be defensive, quietly doing the opposite —
converting a structural error into silence. Iteration 12's version swallowed a
broken lookup. This version *looked* like the code that made a feature work.

The repair deliberately made one of those branches live rather than deleting it.
`_openTutorial('player')` now reaches line 11931 for the first time.

### 13.6 What the new gate cannot see

- **Whether the door is findable.** The rule is satisfied by a table entry
  alone. `player: 'playerTransportTutorialModal'` works only because
  `#pmTransportHelpBtn` calls `_openTutorial('player')`; the fourth test pins
  that exact chain, but the general rule cannot. A route key that nothing
  dispatches would pass. Making the general rule strong enough would mean
  tracing dispatch statically, which is a different project.
- **Overlays that are not tutorials.** The `TutorialModal` suffix is the whole
  net. The 22 hidden overlays include confirms, pickers and panels whose
  reachability is unexamined.
- **Whether a tutorial is about the feature its route claims.** Neither this
  gate nor `modalIds.test.mjs` can see that; iteration 12's Trailers Conform
  defect was caught by a human reading two tables.
- **Tutorials created at runtime.** Only checked-in HTML is scanned.

### 13.7 Follow-ups

- The duplicate `#btnTutorial` handler pair is now three iterations old as a
  known problem. `_tutMap` still lacks a `player` entry (correctly — it is only
  reached with tab keys), which means the two tables are now *legitimately*
  different, and the "keep in sync" comment from iteration 12 is no longer
  literally true. Consolidating the pair would remove both the comment and the
  class of bug.
- `ui.js:24004`'s guard is still dead and now provably so. Left in place: it is
  the fallback handler's mirror of a branch that is live in the primary, and
  deleting half of a mirrored pair is worse than leaving it.
- Carried from 12.7, unchanged: the global How to Use button silently does
  nothing on `bwav`, `preflight`, `renderq` and `home`; the global button shows
  `#tlcTutorialModal` in static English rather than the user's stored tutorial
  language; a tab-name consistency sweep across the other ten tabs.
- Open question worth the next iteration: `.pm-controls` now has a help
  affordance. No other panel in the app does. Which other panels have authored
  help that is reachable only from somewhere non-obvious?

## Audit 14

### 14.1 A new species: the silent no-op control

Every defect species catalogued so far has been a *reference* problem — an id
that points at nothing, a global that is never assigned, content with no door.
This one is different in kind. Every reference involved was valid. The table
`_tutModalMap` was well-formed, every id in it existed, every tutorial it named
was reachable. The defect was a **missing table row**, and the code's response
to a missing row was `return`.

    const modalId = _tutModalMap[tabKey];
    if (!modalId) return;

That is a correct-looking guard. It is the same idiom as the `if (!modal)
return` from iteration 12 and the dead equality guards from iteration 13: a
construct whose stated purpose is defensive, quietly converting a structural
gap into silence. Three iterations, three different shapes, one habit.

What makes it the most user-visible of the three is that the silence lands on a
click. A user who presses How to Use and sees nothing does not conclude "this
screen has no guide". They conclude the application is broken — and they
conclude it at the exact moment they had already admitted to being stuck. One
third of the tabs did this.

The honest framing for the next occurrence: **a control that can do nothing must
say so.** A no-op that is indistinguishable from a crash is a crash, as far as
the only person whose opinion counts.

### 14.2 Three questions about the same two sets, three different blind spots

The gate set now reads:

| Gate | Question | Found |
|---|---|---|
| `modalIds.test.mjs` | does every id a router names exist? | phantom ids |
| `reachableTutorials.test.mjs` | does every authored tutorial have a router? | the stranded player tutorial |
| `tutorialCoverage.test.mjs` | does every **tab** get an answer? | four silent tabs |

The first two were green while a third of the app had no help at all. They are
both about the mapping between *routers* and *modals*, in opposite directions —
iteration 13 already recorded that a one-directional gate has a blind spot
exactly the size of the other direction. What this iteration adds is that
**both directions of a mapping can be complete while the mapping is pointed at
the wrong set entirely.** Neither gate mentioned tabs. Tabs are what the user
touches.

Generalised: before writing a gate over a mapping, name the set the *user*
inhabits and check that it appears on one side of the mapping. Here that set was
`.tabs .tab[data-main]` — twelve elements, eight of them covered, and nothing in
the suite counted them.

A related note on gate honesty. Widening `reachableTutorials.test.mjs` to see
`_openTutorial`'s direct assignment was the second option considered. The first
was a fake `_tutModalMap` entry keyed to a tab that does not exist, which would
have turned the gate green without making anything reachable. The rule the gate
states — "authored content must be reachable" — was right; its *implementation*
had narrowed to "must appear in a table". Fixing the implementation and proving
the widened gate still fails on HEAD's real defect is the difference between
maintaining a gate and decorating one.

### 14.3 HEAD does not contain its own source

This is the largest finding of the run and it was found by accident, while
trying to verify iteration 14 honestly.

Verifying against a `git archive HEAD` tree — the closest thing available to a
fresh clone — does not produce a working checkout. It dies here:

    Error [ERR_MODULE_NOT_FOUND]: Cannot find module
      …/src/scripts/features/aceslook/services/ocfIdtResolver.js
      imported from …/src/scripts/features/vfxPull/colorPlanEngine.js

`colorPlanEngine.js:25` is tracked and committed. `ocfIdtResolver.js` is 9,990
bytes on this disk, dated 27 June, and was never `git add`ed.

A systematic scan of every relative import in every tracked `src/**/*.{js,mjs}`
found this is not one file. **10 tracked files hold 19 static imports of 15
distinct untracked modules:**

| Tracked importer | Untracked module(s) |
|---|---|
| `features/aceslook/services/amfBuilder.js` | `ocfIdtResolver.js` |
| `features/aceslook/services/presetService.js` | `defaultPresets.js` |
| `features/home/homeScreen.js` | `setupWizard.js`, `appTour.js` |
| `features/trlconf/index.js` | `core/resolveVideoTransport.js`, `modules/conform/{pictureMatcher,endRefine,multiMaster,shotDetect,mergeMatches}.js` |
| `features/vfxPull/colorPlanEngine.js` | `ocfIdtResolver.js` |
| `features/vfxPull/fdlGenerator.js` | `ocfIdtResolver.js` |
| `features/vfxPull/vfxPullPanel.js` | `idtBadge.js`, `mediaSearch/mediaSearchBox.js`, `dbLibrarySource.js` |
| `modules/imf/imf_player.js` | `imf_gl_present.js` |
| `modules/imf/imf_ui.js` | `mediaSearchBox.js` |
| `scripts/prep_mark.js` | `modules/conform/pictureMatcher.js`, `vfxPull/backendStatusBadge.js` |

19 edges, 15 modules: `modules/conform/pictureMatcher.js` and
`features/mediaSearch/mediaSearchBox.js` are each imported from two different
tracked files.

The consequences are worse than "a clone is missing some features", for a
reason specific to how the suite runs. `npm run test:js` is a shell loop:

    for f in tests-js/*.test.mjs; do echo "• $f"; node "$f" || exit 1; done

An `ERR_MODULE_NOT_FOUND` is a dead process, so the run stops at
`aeScript.test.mjs` — third file, alphabetically — and **every gate after it
never executes.** That includes `modalIds`, `reachableTutorials`,
`tutorialCoverage`, `domContract`, `accessibleNames`, and the two gates this
loop committed today. On a fresh clone the automated auditing this whole
exercise is building does not run at all, and the failure it reports is a
missing file, not a failing gate.

Local green is green. It is green for a reason that will not survive a clone,
which is a different property from the one the gates claim to establish.

Two ways out, and the choice is the user's, not this loop's:

1. **`git add` the 15 modules.** Fixes HEAD outright. But these are the user's
   in-flight files, and the loop's standing git policy is to commit only the
   files each iteration touches. There is precedent for asking rather than
   assuming — `friendlyError.js` was swept in at `887b161` and a standing offer
   to `git rm --cached` it back out is still open and unanswered.
2. **A shrink-only baseline gate.** `tests-js/selfContained.test.mjs` plus
   `tests-js/fixtures/untracked-imports.json`, modelled exactly on
   `domContract.test.mjs` and its `phantom-ids.json`. Green today against the
   known 19 edges, red the moment a twentieth appears, and the number can only
   go down. This is already the repo's established convention for visible,
   monotonically decreasing debt.

Recommended: (2) now, because it costs the user nothing and stops the debt
growing; (1) whenever the user says the word.

### 14.4 A mixed-state worktree manufactures failures that are not regressions

The first verification attempt swapped HEAD blobs for `index.html` and `ui.js`
into the live worktree. `domContract.test.mjs` promptly went red on three
phantom ids — `#pfxVfxModeToggle`, `#pfxVfxVfFpsVal`, `#pfxVfxVfVisualMatchVal`
— all from `src/scripts/prep_mark.js`.

None of them were caused by the patch. `prep_mark.js` is one of the user's
dirty files and looks up elements that exist only in the user's *uncommitted*
`index.html`. Restoring HEAD's `index.html` beneath it produced a state that has
never existed in any commit and never will.

The lesson is a procedure, not an observation. When verifying against a
baseline in a dirty tree, **the meaningful question is not "does anything fail"
but "is the failure set identical with and without my change".** Here it was,
which is what made the result usable. Building the baseline with `git archive`
instead of in-place swaps avoids the question entirely, and is what the second
attempt did — which is also how 14.3 surfaced.

### 14.5 A gate that reads untracked text is green for the wrong reason

Caught in the new gate before commit, and worth recording because it is the
same defect as 14.3 in miniature. `tutorialCoverage.test.mjs` verifies that
`window.pfxOpenSetupGuide` is actually assigned, by reading
`src/scripts/features/home/setupWizard.js` — which is untracked. On a clone that
`readFileSync` throws `ENOENT`, the process dies, and by the mechanism in 14.3
every later gate silently never runs.

It now reads defensively and `assert.fail`s with the real cause named. This is
the second time in the run that a gate has been found depending on uncommitted
text (two tests in `authConfigInherit.test.mjs` were rescoped for the same
reason before the login fix was committed). Worth treating as a standing check
on every new gate: *would this file's every assertion still be evaluable on a
clean clone?*

Tooling note from the same verification: `asar extract-file <archive> <path>
--output <file>` and the `asar ef` alias both exit 0 and write a **0-byte
file**, which briefly looked like evidence that the packaged app lacked the fix.
The form that works is `cd <tmpdir> && <repo>/node_modules/.bin/asar
extract-file <archive> <path>`, which writes the basename into the current
directory. A tool that reports success and produces nothing is the same species
as everything else in this audit.

### 14.6 What the new gate cannot see

- **Whether the help is correct.** Every assertion is satisfied by an entry
  existing. Prose describing a button removed last year passes.
- **Whether the help is current, or about the right feature.** Same blind spot
  `modalIds.test.mjs` and `reachableTutorials.test.mjs` both have.
- **Whether the user can find the How to Use button**, or whether the modal is
  readable once open. Reachability is not usability, and nothing in the suite
  measures the second.
- **Tabs built at runtime.** Only authored markup is scanned.
- **The other eight tabs' content quality.** The gate proves an answer exists
  for all twelve; it says nothing about the eight that already had one.

### 14.7 Follow-ups

- **Resolved, carried since 12.7:** the global How to Use button silently doing
  nothing on `bwav`, `preflight`, `renderq` and `home`. Fixed in `ff1ec07` and
  gated by `tutorialCoverage.test.mjs`.
- **New, highest value:** the 19 tracked → untracked imports of 14.3. Needs
  the user's decision between `git add` and a baseline gate; the baseline gate
  is the next iteration's candidate deliverable either way.
- `_tutModalMap` holds keys `edl`, `cutdiff`, `shotmarker` and `amf` that are
  not in the `data-main` tab set. They are legacy keys `#btnTutorial` can never
  dispatch. The new gate checks the reverse direction for `_tutFallbackContent`
  but not for `_tutModalMap`; extending it, or deleting the keys, would close
  the last gap in this mapping.
- The duplicate `#btnTutorial` handler pair is now five iterations old.
  Consolidating it would remove both iteration 12's now-inaccurate "keep in
  sync" comment and the entire bug class.
- Carried, unchanged: the global button shows `#tlcTutorialModal` in static
  English rather than the stored tutorial language; a tab-name consistency sweep
  across the other ten tabs.
- Open question from 13.7, still open and now sharper: `.pm-controls` has a help
  affordance and no other panel does. Iteration 14 answered the *tab* level of
  this question exhaustively. The *panel* level is unmeasured — there is no set
  of "panels" in the markup to enumerate the way `data-main` enumerates tabs,
  which is itself the reason nothing has ever checked it.

## Audit 15

### 15.1 A new species: the doubled path segment inside an empty catch

`render_queue.js:807` imported `'./scripts/modules/native_helper_client.js'`
from a file already inside `src/scripts/`. The resolved path,
`src/scripts/scripts/modules/`, has never existed. The import threw on every
single execution, and `catch {}` discarded the throw.

What makes this its own species rather than another silent no-op is the
*direction of the lie*. Iterations 12–14 found controls that did nothing and
said nothing. This one did nothing and said something — it said:

    Native helper not available — start Resolve manually, then retry

That is a confident, specific, actionable diagnosis of a problem on the user's
machine, emitted by code that never looked at the user's machine. The failure
was one directory name in the same file, and the only artifact that named it
was destroyed by the catch a microsecond after it was created.

An empty catch converts "this program has a bug" into "your environment is
missing something". That conversion is the defect. The fix logs through the
file's existing `_dbgRe` channel, so the next failure arrives with a reason.

### 15.2 `src/` is not the tree this code runs in

The gate's first scan reported `src/sandbox/j2k_decoder.js -> src/assets/imf/jpeg2000_pure.js`
as **absent**, and it was wrong.

`build-renderer.js:85-90` copies the *contents* of repo-root `assets/` and the
*contents* of `src/` into one directory, as siblings. Line 143 does the matching
rewrite for HTML: `html.replace(/(["'(])\.\.\/assets\//g, '$1assets/')`. So
`sandbox/j2k_decoder.js` importing `'../assets/imf/jpeg2000_pure.js'` is correct
at runtime — it lands on `dist/desktop/assets/` — and looks broken to anyone who
resolves it against the source layout, where `src/assets/` does not exist.

Resolving in the shipped tree's coordinates and mapping back is the difference
between a gate reporting a real dead import and a gate reporting the repository's
own directory structure at somebody. Getting it wrong made the first run accuse a
working decoder fallback of being dead. Absent edges went 4 → 2 once corrected.

The general lesson for every future scanner in this repo: **the import graph must
be resolved in the coordinates of the tree that runs, not the tree that is
edited.** Two other paths through `build-renderer.js` do the same relocation.

### 15.3 The arithmetic of a suite that only runs here

Audit 14.3 established that HEAD does not contain its own source. Iteration 15
measured the blast radius.

- `tests-js/` holds **103** `*.test.mjs` on disk. **73** are tracked. **30** are not.
- Ten tracked `src/` files hold **21** distinct relative import edges — 19 static,
  2 dynamic — to **15** modules nobody committed.
- `git archive HEAD` dies at `tests-js/aeScript.test.mjs` with
  `ERR_MODULE_NOT_FOUND` on `ocfIdtResolver.js`, which is 9,990 bytes on this
  disk and was never `git add`ed.

`aeScript.test.mjs` is the **third tracked test file alphabetically**. With a
runner that exited on first failure, that single missing file meant a fresh clone
executed **2 gates out of 73** while this machine executed 103. The XSS scan, the
DOM contract, the accessibility names, the tutorial coverage — seventy-one gates
in between — never ran anywhere but here, and reported nothing, and reported it
as success right up until the exit code.

These figures supersede and extend audit 14.3's "19 tracked files import 14
distinct untracked modules", which was itself corrected pre-commit to 19 edges /
15 modules / 10 importers. The complete set is: **10 importers, 21 edges, 15
modules, 103 test files, 73 tracked.**

### 15.4 A better failure mode is not a fix

`package.json`'s `test:js` now collects failures instead of exiting on the first
one. A crash costs one gate rather than all of them.

This is worth stating plainly because it is exactly the kind of change that reads
as a fix in a changelog and is not one. The fifteen modules are still missing. A
clone still cannot run `aeScript.test.mjs`. What changed is that the other
seventy-one gates now get to speak, so the *next* person to clone this repository
learns seventy-two things instead of one. The underlying debt is untouched and is
recorded in three baselines rather than resolved.

### 15.5 Two dead fallbacks that are harmless, and why they stay baselined

`ui.js:118-127` has a two-tier legacy import for `nuke_import_script.js` and
`amf_convert.js`. The first tier, `./modules/…`, exists and ships. The second
tier, `./amf_convert.js` and `./nuke_import_script.js` at `src/scripts/` root,
exists nowhere — not in git, not on disk, not in the bundle.

They are the only two `absent` edges in the tree. They are also genuinely
harmless: `catch`-guarded, unreachable in practice because tier one always
resolves. Deleting them is correct and is not this iteration's business — they
are two lines in a file with 594 modified siblings in the user's working tree.
Baselined at exactly 2, shrink-only, so removing them is a one-line edit to a
fixture and adding a third is a failure.

### 15.6 What the new gate cannot see

- **Anything not written as a string literal.** `import(dynamicPath)` is
  invisible in both directions — a broken dynamic path will not be caught, and a
  module reached only that way will look unused.
- **CommonJS.** `electron/` is `require()`-based and entirely out of scope. This
  is the most important gap: the *same defect* there breaks the application
  rather than the test suite. It deserves its own pass.
- **Whether an imported module is correct.** Only whether it will be there.
- **Whether a file that exists is reachable at runtime.** A tracked module
  nothing imports passes, as it should.
- **Node built-ins and packages.** Bare specifiers resolve through
  `node_modules` and are the lockfile's problem.

### 15.7 Follow-ups

- **Resolved from 14.7:** the untracked-import debt now has the baseline gate
  that 14.7 named as "the next iteration's candidate deliverable either way".
  The underlying decision — `git add` the 15 modules and 30 test files, or leave
  them baselined — is still the user's and is still open. The gate holds the line
  in the meantime.
- **New, highest value:** the CommonJS `require()` graph under `electron/`. A
  doubled path segment there is not a dead button, it is a dead application. The
  gate built this iteration cannot see it, and nothing else does either.
- **New:** `ui.js`'s two dead second-tier legacy fallbacks (15.5), removable
  whenever that file is next opened for a real reason.
- Carried, unchanged: `_tutModalMap`'s four legacy keys; the five-iteration-old
  duplicate `#btnTutorial` handler pair; the global How to Use button showing
  `#tlcTutorialModal` in static English; the tab-name consistency sweep;
  `.pm-controls` being the only panel with a help affordance.

## Audit 16

### 16.1 A defect species with no failure mode: the silent fall-through

Every species catalogued so far announces itself. A phantom id resolves to
`null`. A doubled path segment throws. A destructive default destroys something.

`t()` does none of that:

```js
export function t(str, langOverride){
  const lang = normLang(langOverride || getLang());
  const map = DICT[lang] || {};
  return map[str] || str;
}
```

A missing translation returns the English key. No throw, no warning, no console
line, no `undefined` rendering as text. The UI is fully functional and entirely
correct-looking. The only observer who can detect the defect is a user who does
not read English — precisely the user the feature exists for.

This is why 366 missing translation pairs survived fifteen iterations of gates
that check the DOM contract, accessibility names, XSS, XXE, fail-open patterns,
tutorial coverage and module resolution. **None of those gates were wrong. The
defect has no runtime signature to catch.** It is only visible by counting, and
nothing counted.

Species added: **absent-translation** and **identity-translation**.

### 16.2 The gap had a shape, and the shape was the cause

Measured across the merged 660-key dictionary: keys present in exactly *n*
locales — 6 → 461, 5 → 13, 4 → 156, 3 → 27, 2 → 0, 1 → 3.

That spike at 4 is the whole story. 156 keys sat in exactly four locales; ko and
ja were each missing 150 keys, **142 of them identical**. A random accumulation
of oversights does not produce two locales missing the same 142 strings. One
block does: `LOCALE_FULL_DICT` (303 keys) was authored for zh-TW / th / id /
fil, and ko / ja received 157 of it.

Worth recording as method: the per-locale coverage percentages said "ko and ja
are behind". The histogram said *why*, and turned 300 apparent oversights into
one unfinished block. Counting the distribution cost one extra query and changed
the diagnosis.

### 16.3 A hypothesis killed by measurement

Going in, the working lead was that `ERROR_DICT` lacked `zh-TW`. It was checked
before any code was written: **all four dictionaries carry all six locales.**
The lead was false, and the real defect was somewhere else entirely.

Recording this because it is the second time in this run that the pre-work
hypothesis was wrong and measurement caught it before the fix went in (audit
11.4 was the first). A lead is not a finding.

### 16.4 "Provably translatable" — the honest bar for a translation gate

The tempting metric is *does every locale have every key*. It is wrong, and it
fails in the direction that makes a gate useless: it demands Tagalog for
"Lens Flare" and Indonesian for "VFX Marker", terms those locales keep in
English on purpose, as their own existing dictionaries show.

The bar this gate uses instead: a key counts against locale L only if some
**other** locale renders it as something other than the English key. A human has
already demonstrated the string can be said in another language, so L falling
back is a gap rather than a decision.

That filter is the difference between a gate people obey and a gate people
add exceptions to until it means nothing.

### 16.5 Absence is a defect; identity is only evidence

The two species are not equally strong and the gate does not treat them so:

- **absent** — no entry, `t()` returns English. When the key is provably
  translatable, this is a defect with no defence. **31 remain**, each an explicit
  decision recorded in a fixture.
- **identity** — an entry whose value equals its key. Sometimes correct, sometimes
  a translator typing the English back. **250 remain**, recorded and bounded but
  not called bugs.

Both baselines shrink-only with hard numeric literals, so raising either is an
edit somebody has to justify in review.

### 16.6 Executing the code beats parsing it

`tests-js/lib/i18nDict.mjs` slices `i18n.js` at the `// Build key set` marker,
drops its single relative import, appends an export, and imports the result from
a base64 `data:text/javascript` URL.

The alternative — parsing four dictionary literals and re-running four merge
loops in the test — was rejected on a principle worth stating generally: **a gate
that re-implements the thing it measures drifts away from it.** The moment a
fifth dictionary or a different merge order lands, a parsing gate reports
confidently on a dictionary the app no longer builds. Executing the file's own
construction half means the gate reads exactly the objects `t()` reads, and a
change to the merge logic either flows through or trips the slice marker.

The `data:` URL over a temp file: no filesystem side-effects, no ESM import-cache
to bust between runs.

### 16.7 A gate that has never failed has not been shown to work

`tests-js/i18nParity.test.mjs` was mutation-tested before it was trusted. One
real entry deleted under an occurrence guard; **exactly two** tests failed, and
they were the right two; the shrink and staleness gates correctly stayed green
(a deletion makes the baseline *stale*, not *exceeded* — and staleness is checked
against the fixture, which still matched). Restored, `diff -q` byte-identical.

Equally: the two fixtures were checked four ways against measured ground truth
before entering the repo — NOT-ABSENT / IDENTITY / EMPTY / OVERRIDE. That check
caught two entries where **I had violated my own stated rule**, writing English
straight back for `"VFX Plate:"` in ko and ja. They were removed rather than
disguised with a fullwidth colon.

An authored dataset is data. Verify it like data.

### 16.8 What this gate cannot see

- **Translation quality.** It sees presence and difference. `"Export"` →
  `"바나나"` passes.
- **Strings that never reach `t()`.** `src/index.html` contains **0**
  `data-i18n` attributes — the main UI translates imperatively via `applyI18n`
  and the `_ORIG_TEXT` WeakMap. Any label the imperative pass misses is invisible
  here.
- **The app's other i18n implementations.** bwav's `I18N` (92 keys × 6 locales,
  verified perfect parity this iteration) and
  `src/tools/preflight/app/locale.js` (`PREFLIGHT_LOCALES` = the same seven,
  `DEFAULT_LOCALE = 'en'`) are separate dictionaries with separate gaps.
  `src/tools/visionscope/*` has not been examined at all.
- **Plurals and interpolation.** The dictionary is flat string→string.

### 16.9 Cleared this iteration

- **`electron/`'s CommonJS require graph** — audit 15.7 called this "new, highest
  value: a doubled path segment there is not a dead button, it is a dead
  application". Measured: **26 relative `require()` calls, 26 resolve.** Clean.
  Closed.
- **82 dynamic `import()` sites in `src/`** — 18 swallow failure silently, but all
  18 targets resolve in `dist/desktop`. No action; the silent-catch pattern is
  noted, not a live defect.
- **bwav `zh-TW` i18n** — a backlog item claimed it had no dictionary. False:
  92 keys × 6 locales, exact parity. The item was stale and is removed.

### 16.10 Follow-ups

- **New, and the user's call rather than mine:** the 31 absent and 250 identity
  entries are a native-speaker review, not a scripting problem. The sharpest case
  is `Vendor`, `Config` and `Continuity`, where `id` and `fil` diverge — I kept
  them English in `fil` on industry usage, and that is exactly the kind of
  judgement a Filipino post supervisor should overrule in ten seconds.
- **New:** `src/index.html`'s zero `data-i18n` attributes. The imperative
  translation pass is untested and unmeasurable; a declarative attribute would be
  gate-able. Large change, real payoff, not a nightly-loop-sized job.
- **New:** `src/tools/visionscope/*` i18n status, unexamined.
- Carried from 15.7: the untracked-import decision (15 modules, 30 test files)
  is still the user's, still baselined. `ui.js`'s two dead second-tier fallbacks.
- Carried, unchanged: `_tutModalMap`'s four legacy keys; the duplicate
  `#btnTutorial` handler pair; the global How to Use button showing
  `#tlcTutorialModal` in static English; the tab-name consistency sweep;
  `.pm-controls` being the only panel with a help affordance.

## Audit 17 — measuring the UI instead of the dictionary

### 17.1 The measurement

`tests-js/lib/uiStrings.mjs` walks `src/index.html` exactly the way `applyI18n`
walks the live DOM — same explicit stack, same `script`/`style` skip, same five
kinds (text node, `title`, `placeholder`, `aria-label`, `<option>` text) — and
resolves every string through the app's own `toEnglishKey`. 2310 distinct keys
reach a lookup; 2060 survive the prose filter; **1744** have no dictionary key.

The prose filter errs toward keeping: a false keep is one more visible line of
debt somebody can dismiss in review, a false drop hides a real gap forever. It
drops only strings with no two consecutive letters, URLs, anything containing
braces (command templates — translating `{metafier} -e {out}` would break the
command), pure digits/punctuation, bare file extensions, and filesystem paths.

### 17.2 Species found

- **case-mismatch-miss** (new) — markup `"NAME"`, dictionary `"Name"`, no match.
  20 instances, all now resolved by `FOLD_INDEX`. The translation existed the
  whole time; the lookup could not reach it.
- **vacuous-assertion** (new) — a test that survives the mutation it was written
  to catch. One instance, mine, found by mutation testing rather than by review.
- **absent-translation** — 34 (up from 31 by measurement growth, not regression).
- **identity-translation** — 250, unchanged.

### 17.3 Gate honesty

Two of the twelve tests exist only to keep the other ten meaningful:

- *"the walk reaches every kind of string applyI18n translates"* — a walk that
  silently stopped early would report zero misses and look perfect.
- *"the scan can tell a covered string from an uncovered one"* — probed both
  directions, because a detector that never fires and one that always fires both
  report "no problem" on the day it matters.

The exclusion list (`X-PostFlowX-Token`, `name@example.com`) is checked for
staleness — an exclusion for a placeholder that no longer exists is a claim
about the UI that stopped being true — and capped at 2. It is an exclusion list
with a reason per entry, not a baseline, and the cap is what keeps it from
quietly becoming one.

`MAX_ABSENT` went 31 → 34. The justification is written into
`i18nParity.test.mjs` rather than left in a commit message, because a baseline
is a debt list and raising one should be an edit somebody has to defend in
review. The three new entries are honest holes in `UI_DICT_ROWS`, not
regressions: filling them with key→key pairs would have held the number at 31
while changing nothing a user reads — the same silent no-op this repo keeps
finding in other forms.

### 17.4 What the gate cannot see

Stated in the test header so nobody reads a green build as more than it is:
strings built in JavaScript at runtime (`ui.js` creates plenty of DOM, none of
it measured here); whether any translation is *good*; the other two dictionaries
(bwav's `I18N`, preflight's `locale.js`) which are separate implementations with
separate coverage; and wording drift, which it reports as a miss without being
able to say a near-identical key already exists.

### 17.5 Deployment

`npm run build:mac-dir` (unsigned, local). Verified end-to-end by extracting
`dist/desktop/scripts/modules/i18n.js` from the packaged `app.asar`: `FOLD_INDEX`
present, `UI_DICT_ROWS` present, and the Tagalog aria-label "Laki ng brush"
present in the shipped bundle. A signed/notarized `npm run build:mac` needs the
user's Apple credentials and pushes an artifact outward; that has not been
authorized and was not run.

---

## Audit 18 — how far "we fixed the error messages" actually got

Iteration 5 landed `errorBanner.js` and the note in this file said the raw-error
problem was closed. It was closed on one surface. This audit measures the rest.

### 18.1 Raw exception text by display surface

Scan: every `.js` under `src/`, comments stripped, counting lines where a
display call and an interpolated exception field (`.message` / `.code`) appear
together.

| surface | sites | files | state after this iteration |
|---|---|---|---|
| `showError()` | 16 | 1 (`ui.js`) | covered since iteration 5 |
| `setStatus()` / `_setStatus()` | 15 | 3 | **13 covered, 2 recorded as debt** |
| `alert()` | 12 | 5 | not covered |
| `__toast()` | 1 | 1 | not covered |

Total 44 sites; 29 now route through a rewriter, 15 do not.

The scan is line-based and therefore undercounts: `const m = 'X: ' + e.message;
setStatus(m)` reads clean. Those are still rewritten at the boundary — the scan
just cannot count them. It does not overcount, since comments are blanked first.

### 18.2 A correction to an earlier note

A previous iteration recorded the remaining toast site as
`features/amf/amf_convert.js:2068`. The file is `modules/amf_convert.js:2068`
and the call is `__toast(...)`, not `toast(...)`. The line number was right; the
path and the function name were not. Noting it because a wrong path in a backlog
is worse than no entry — somebody looks, finds nothing, and concludes the item
is done.

### 18.3 The gate, and what it is worth

`tests-js/friendlyStatus.test.mjs`, 13 tests. Shape:

- **scan sanity** — the walk must find ≥3 files and ≥15 sites, and must report
  exactly 9 for `vfxPullPanel.js` and 4 for `imf_ui.js`. A silently-broken
  detector reports zero offenders and looks like success.
- **comment stripping** — `friendlyError.js` documents the bug it fixes by
  quoting a real call site. Without stripping, the fixer is reported as an
  offender. There is a test that pins this.
- **boundary extraction, not grep** — the routing check pulls the single named
  function out of the file and asserts `friendlyStatus` is called inside it. A
  plain file-level grep would pass on a file that imports the helper and calls
  it anywhere at all while every call site stayed raw. That is the vacuous
  version of this test and it was written the other way on purpose.
- **shrink-only debt list** — `UNROUTED` must be sorted, unique, bounded by a
  hard literal (1), and every entry must still describe a file that actually has
  raw-error sites. An exemption that outlives its subject is a claim about the
  code that stopped being true.
- **both directions on the rewriter** — six real raw-exception strings must be
  rewritten with their label intact; nine real success/progress strings must
  come back byte-identical.

### 18.4 Mutation results

Five mutations, each anchor-guarded to exactly one occurrence, each restored and
proven byte-identical with `diff -q`:

| mutation | expected | result |
|---|---|---|
| M1 boundary stops calling `friendlyStatus`, import left in place | catch | **2 fail** |
| M2 prefix-preserving branch removed (becomes `friendlyText`) | catch | **3 fail** |
| M3 `\s` dropped so a single-token label is allowed | catch | **1 fail** |
| M4 `prep_mark.js` quietly deleted from `UNROUTED` | catch | **1 fail** |
| M5 comment stripping disabled | catch | **1 fail** |

M3 is the one worth keeping. It is a one-character change that makes the feature
actively harmful rather than merely absent, and only one test in the file
notices it.

### 18.5 Deploy

`npm run build-verify` exit 0, `npm run build:renderer` exit 0 (372 files).
`npm run build:mac-dir` and asar verification below. A signed/notarized
`npm run build:mac` needs the user's Apple credentials and pushes an artifact
outward; that has not been authorized and was not run.

Verified inside the shipped `app.asar` (packaged 2026-07-27 01:12):

- `dist/desktop/scripts/core/friendlyError.js` exports `friendlyStatus`.
- `vfxPullPanel.js:4150` `_setStatus` calls it, guarded by a `catch` that falls
  back to the raw text — a rewriter that throws must never swallow the status it
  was handed.
- `imf_ui.js:5500` `setStatus` likewise.

One behaviour change worth recording rather than discovering later:
`setStatus('x', undefined)` used to render the literal string `"undefined"` and
now renders empty. That is an improvement, but it is a change, and if some
caller was relying on seeing `undefined` to notice a bug, it no longer will.

---

## Audit 19 — a Cancel button that did not cancel

### 19.1 The defect

Review notes (JSON/CSV) and visual-QC reports are saved through a three-route
cascade, because no single route works everywhere:

| tier | route | dialog? |
|---|---|---|
| 1 | `chrome.downloads.download({ saveAs: true })` | yes, native Save As |
| 2 | `window.showSaveFilePicker()` | yes, native picker |
| 3 | anchor `click()` with a blob/data URL | **no** — silent write to Downloads |

Every tier answered with a boolean: did the file get written? That collapses two
different answers into one value. *The user pressed Cancel* and *this route is
unavailable here* both returned `false`.

So the observed behaviour was: press Cancel on the Save dialog → the cascade
reads a route failure → a second dialog opens → press Cancel again → tier 3
runs, and tier 3 has no dialog to cancel. The file lands in Downloads.

Cancel meant "ask me twice, then do it anyway". For a non-technical user this is
worse than an error: nothing appears to go wrong, and a file they explicitly
declined to save exists on their disk.

Two independent copies of `downloadOrSaveText` had the bug, in
`features/reviews/index.js` and `components/visualQcModal/index.js`.

### 19.2 The finding that made the rest of it matter

Mid-implementation, `src/scripts/electron_shim.js` turned out to build the
renderer's `chrome` object entirely out of spreads:

```js
merged.runtime = { ...(existing.runtime || {}), ...(shim.runtime || {}) };
```

`electron/preload.js` deliberately defines `runtime.lastError` with
`Object.defineProperty` and a live getter. **A spread invokes an accessor once
and copies the resulting value as a plain data property.** The renderer
therefore received `lastError` frozen at whatever it read during load — `null` —
and it could never change again.

Consequence, stated plainly: **every `if (chrome.runtime.lastError)` in the
renderer was dead code in the desktop build.** Not just for downloads — for any
shimmed Chrome call that reports failure that way. A cancelled download, a
failed `sendMessage`, all reported nothing at all.

This is why the iteration is four changes and not one. Links 1, 2 and 4 could
all have been written, tested, and shipped green, and nothing on screen would
have changed, because the value never reached the renderer. Fix the whole chain
or none of it.

New species for the catalogue: **getter-flattened-by-spread**.

### 19.3 The four links

| # | file | change |
|---|---|---|
| 1 | `electron/ipc.js` | dismissed `showSaveDialog` returns `{ ok: false, canceled: true }`, not a bare `{ ok: false }` |
| 2 | `electron/preload.js` | translate that to `runtime.lastError = { message: 'USER_CANCELED' }`, readable only inside the callback, cleared in a `finally` |
| 3 | `src/scripts/electron_shim.js` | re-install the accessor descriptor after the merge |
| 4 | `src/scripts/core/saveOutcome.js` (new) + both cascades | three outcomes and one runner that stops on a cancel |

Link 2 is worth defending. `USER_CANCELED` — one L — is real Chrome's own
spelling, and lastError being readable only from inside the callback is real
Chrome's own lifetime. Matching both is not politeness toward the API; it is
what lets ONE piece of renderer code recognise a cancel in the desktop app and
in the extension. An approximate shim would have forced two code paths.

### 19.4 What is deliberately not a cancel

`showSaveFilePicker` rejects with *"The request is not allowed by the user agent
or the platform in the current context"* when it is called without a transient
user activation. That is the route being unusable, not the person declining.
Classifying it as a cancel would stop the cascade and silently abandon an export
the user did ask for. `isUserCancel` recognises `AbortError`, `canceled`/
`cancelled: true`, and the `USER_CANCELED` wording — and not that string.

### 19.5 Mutation test — and a hole in the gate

Seven mutations, one per link plus one per behaviour the gate claims to protect:

| # | mutation | caught? |
|---|---|---|
| M1 | shim getter re-install deleted | **1 fail** |
| M2 | `canceled` flag dropped from the IPC reply | **1 fail** |
| M3 | runner falls through on `CANCELLED` | **3 fail** |
| M4 | `isUserCancel` over-fires on `NotAllowedError` | **1 fail** |
| M5 | `visualQcModal` bypasses the runner | **1 fail** |
| M6 | preload leaks `lastError` past the callback | **1 fail** |
| M7 | a tier helper reverted to `return !!downloadId;` | **none — survived** |

M7 is the interesting one, and it is a failure of my own gate rather than of the
source. The assertion read:

```js
assert.doesNotMatch(body, /return (?:true|false);/);
assert.match(body, /CANCELLED/);
```

`return !!downloadId;` contains neither literal, so the first assertion passes.
`CANCELLED` still appears in the function's catch block, so the second passes
too. Seventeen green tests, and a helper handing the runner `true` — which is
neither `SAVED` nor `CANCELLED`, so the runner falls through to the next tier
and opens a second dialog after a *successful* download.

The lesson is one this report has recorded before in another costume: a gate
that enumerates forbidden spellings is guessing at the mutation. The repaired
version enumerates every `return` statement in each helper body and requires
each one to carry an outcome constant, with a single documented exception for
`return reject(...)` inside the nested Promise executor. Re-run under M7 it
fails with the offending line quoted. Restored, all six files `diff -q`
byte-identical, 17/17.

### 19.6 Out of scope, on purpose

`src/scripts/pfxPlatform.js:64-84` `saveFile()` has the identical collapse
(`void chrome.runtime.lastError; resolve(id ? defaultPath : null);`). It has
**zero callers repo-wide**, so fixing it would be unverifiable churn. Recorded
here and in the test header rather than silently skipped.

`friendlyError.js` has no rule for `AbortError` or for the "not allowed by the
user agent" wording, so if either ever does reach a user it arrives raw. Carried
to iteration 20 alongside the 12 `alert()` sites.

### 19.7 Deploy

`npm run build-verify` exit 0, `npm run build:renderer` exit 0 (373 files).
Committed as `bf455e0`, seven files, verified with `git show --numstat` to carry
no foreign hunks — the three dirty files (`electron/ipc.js` 528/13,
`electron/preload.js` 26/1, `reviews/index.js` 6/6 of the user's in-flight work)
were staged as reconstructed blobs built from `HEAD`, and each blob was diffed
against `HEAD` before staging to prove it contained my hunks and nothing else.
A signed/notarized `npm run build:mac` needs the user's Apple credentials and
pushes an artifact outward; it has not been authorized and was not run.

## Audit 20 — the dialog that only told you the error class

Iteration 19 fixed the status strip. This one is about the modal that opens on
top of it. Twelve places in the app answer a failure by calling `alert()` with
text taken straight off the exception, in two shapes:

```js
alert(`Rescan failed: ${e?.message||e}`);     // labelled, but the label is the only friendly part
alert(err?.message || String(err));            // no label at all
```

Four of the seven sites converted here were the second shape. A colourist who
clicks **Export Notes (PDF)**, waits, and gets a box containing only
`Cannot read properties of undefined (reading 'getContext')` has been told
nothing: not what failed, not whether their work is safe, not what to do. The
first shape is better only in that it names a feature — `Proxy error:` is the
tab name, not the operation the user asked for.

### 20.1 Why not just reuse `friendlyText`

`friendlyText` glues `message + ' ' + hint` into one line, and that is correct
where it is used. `errorBanner.js:121` renders through `el.textContent = msg`
with default `white-space`, so a `\n` there collapses to a space anyway — the
single line is the honest representation of what that surface can display.

A native `alert()` is the opposite: it *does* honour `\n`, and it has room. So
`core/friendlyAlert.js` composes from the structured parts instead —
`translate(label)`, `f.message`, `f.hint`, joined on a blank line, with empty
parts dropped so a missing hint never leaves a hole. `friendlyText` was left
byte-untouched; the two surfaces have different constraints and now say so in
code rather than by coincidence.

`friendlyAlert` looks up `globalThis.alert` **at call time**, never captured at
import. That is what lets the test inject a recorder, and it is also what keeps
the module importable in Node without a DOM.

### 20.2 A test written for the new module found a bug in the old one

The test asserting that a path and the advice about it do not share a line was
written against `/Volumes/SHOW DRIVE 01/sh010/a.ari`. It failed. Not on the
line-splitting — on the path itself.

`friendlyError.js`'s `_path` matched `(?:\/[^\s:'"]+)+`, which stops at the
first space. Handed Node's

```
ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/a.ari'
```

it returned `/Volumes/SHOW`. That is worse than returning nothing: it names a
plausible-looking folder that does not exist, and sends the user to look in the
wrong place. Post-house volumes are called `SHOW DRIVE 01` and
`Client Delivery`, not `showdrive01`, so this is the common case, not the edge
case. It has been shipping inside `errorBanner` since `friendlyText` landed.

The fix is a two-pass `_path`, ordered deliberately: Node quotes the path in
every `fs` error, and inside quotes the end of the path is unambiguous, so a
quoted path is taken whole, spaces and all. The old whitespace-terminated scan
stays only as the fallback for messages assembled without quotes. Two
regression assertions were added to `friendlyError.test.mjs` (23 → 25).

The general form of this, worth keeping: **writing a test for module B is a
legitimate way to find bugs in module A**, and the ones it finds are the bugs
nobody thought to look for, because if anyone had thought about them they would
already be fixed.

### 20.3 Seven converted, five deliberately not

| File | Sites |
|---|---|
| `src/scripts/features/reviews/index.js` | 4 |
| `src/scripts/features/vfxPull/vfxPullPanel.js` | 1 |
| `src/scripts/modules/smart_engine_settings.js` | 1 |
| `src/scripts/modules/imf/imf_package_ui.js` | 1 |
| `src/tools/preflight/app/app.js` | **5 — not converted** |

The preflight deferral is architectural, not laziness. `src/tools/*` are
separate documents loaded as **iframes**; nothing under `src/tools/` has ever
imported from `src/scripts/`, and the only channel that crosses the boundary is
the `pfx:lang` postMessage in `scripts/core/paneLang.js`. Reaching into
`../../scripts/core/friendlyAlert.js` from a pane would invent an import edge
the architecture does not have, to deliver *English* text into a pane that
already speaks seven languages: preflight loads its own
`ui_strings.{en,ja,ko,zh-TW,th,id,fil}.json`, and `window.PFX_t` does not exist
inside that iframe.

Doing it properly means adding error sentences to the pane's own dictionary —
which currently contains **zero** of them — so seven locales × ~6 keys = 42 new
translations. That is a translator's job, not a refactor. Recorded as open work
rather than shipped as a regression dressed up as a fix.

This is the counterpart to "fix the whole chain or none of it." That rule
applies to a *causal chain*, where fixing four links out of five delivers no
user-visible change at all. Twelve independent call sites are not a chain:
fixing seven fully fixes seven users' experiences, and the other five are
honestly named.

### 20.4 What the gate checks

`tests-js/friendlyAlert.test.mjs`, 9 tests, two halves.

The module half proves the label leads, that a path and its advice occupy
separate lines (the assertion compares the path line's `.trim()` to the exact
expected path — an equality, not a substring, which is why it caught 20.2),
that missing parts leave no blank paragraphs, that dispatch goes through
`globalThis.alert` looked up at call time, that with no alert available the text
reaches the console rather than nowhere, and that an alert which throws still
returns the text.

The call-site half is the part that stops the fix rotting. It requires each
converted file to import `friendlyAlert`, to carry exactly the expected call
count, and — the load-bearing one — that no line matching `/(?<!friendly)\balert\(/`
also matches `/\.message\b|String\(\s*(?:err|e)\s*\)/`. A new raw alert added
beside a fixed one fails the suite. A separate test requires every label to
read as an operation rather than an error class: whitespace present, ≥8 chars,
matching `/fail/i`, counted at exactly 7.

### 20.5 Mutation results

Six mutations, all caught:

| # | Mutation | Caught by |
|---|---|---|
| M1 | Revert one converted site to the raw alert | call-site count + raw-in-alert scan |
| M2 | Add a raw alert next to a good one | raw-in-alert scan |
| M3 | Drop the `friendlyAlert` import | import assertion |
| M4 | Label → `'Error'` | label-shape test (length, whitespace) |
| M5 | Label → `'Failed'` | label-shape test (length, whitespace) |
| M6 | Remove the `translate` export from `friendlyError.js` | export guard + module tests |
| M7 | Revert `_path` to the single-pass regex | both suites |

M6 is worth a note for the second time this run: the first attempt at it used
an over-escaped `perl` substitution that **silently did not apply**. Both suites
passed, which would have read as "the gate does not catch this" when in fact
nothing had been mutated. Redone with a verified substitution, it failed as
required. **A mutation that fails to apply proves nothing** — check that the
edit actually landed before believing either colour.

All eight touched files restored `diff -q` byte-identical afterwards.

### 20.6 Process finding: `git commit --only <paths>` discards a staged blob

This one cost a commit and is worth recording, because the reconstructed-blob
workflow is used in most iterations of this run.

Two of the six edited files also carry the user's uncommitted in-flight work
(269/129 hunks in `vfxPullPanel.js`, 6/6 in `reviews/index.js`). The standing
policy is to commit only my own hunks, so the index was built with
`git hash-object -w` on a blob reconstructed from `HEAD` plus my edits, staged
via `git update-index --cacheinfo`, and each blob diffed against `HEAD` first to
prove it contained nothing foreign. That part worked exactly as intended.

The commit did not. `git commit --only <paths>` **re-reads the working tree for
the named paths** and discards whatever was staged for them. Commit `b2360b7`
therefore contained the user's 269/129 and 6/6 hunks anyway — a perfectly
staged index, thrown away at the last step. It was visible immediately in the
output as unexpected `mode change 100644 => 100755` lines, and confirmed with
`git show --numstat`.

Recovered with `git reset --soft HEAD~1 && git reset -q` (worktree untouched,
verified byte-identical against the backups in `/tmp/mu20/`), re-staged
identically, and committed with **no pathspec at all** so the index is what
lands. Result `1ffde29`: reviews 5/4, vfxPull 4/1, no mode changes, and the
user's foreign remainders back at 6/6 and 269/129 in the worktree.

Every earlier reconstructed-blob commit in this run (`bf455e0`, `996bedf`,
`9a08615`) was then audited with `git show --numstat` for the same signature.
None carry it. The rule now: **after reconstructed-blob staging, `git commit -F
<msg>` with no pathspec — never `--only`.**

While there, a second mode trap: `git update-index --chmod=-x` on
`friendlyError.js` *introduced* a mode change, because that file is **100755 at
HEAD**, not 100644 (so is `reviews/index.js`). Check `git ls-tree HEAD` before
normalising, and verify with `git diff --cached --summary`.

### 20.7 Out of scope, on purpose

`vfxPullPanel.js:8246` builds a multi-shot failure summary by interpolating
`r.error` per shot. It is raw text, but it is *N* errors rather than one
exception, so it needs its own shape — a `friendlyAlert` conversion would not
fit it. Named, not silently skipped.

`errorBanner`'s hint glue: switching `friendlyText` to join on `\n` would not
help on its own, because `errorBanner.js:121` uses `textContent` with default
`white-space`. The fix is CSS (`white-space: pre-line`) *plus* the join, and it
belongs to whoever owns that surface's layout.

`runSaveCascade` returning `UNAVAILABLE` is still not surfaced at any of its
seven call sites (`reviews` 8704/8709 and the four converted here;
`visualQcModal` 780/1705/1712).

### 20.8 Deploy

`npm run build-verify` exit 0 (the two `selfContained.test.mjs` failures present
before staging clear once the new files are in the index), `npm run
build:renderer` exit 0, 374 files. Committed as `1ffde29`, eight files, verified
with `git show --numstat` to carry no foreign hunks. A signed/notarized
`npm run build:mac` needs the user's Apple credentials and pushes an artifact
outward; it has not been authorized and was not run.

---

## Audit 21 — the export that finished without saying anything

Audit 20 closed with a line on the still-open list: *"`runSaveCascade` returning
`UNAVAILABLE` is still not surfaced at any of its seven call sites."* This is
that item, measured properly and closed.

### 21.1 What a user would have seen

`runSaveCascade` answers with one of three outcomes — `SAVED`, `CANCELLED`,
`UNAVAILABLE`. All seven consumers in the app discarded it. So two endings that
could not be more different were indistinguishable from the user's chair:

| What happened | What the app did |
|---|---|
| You pressed Cancel in the Save dialog | nothing, silently |
| Every route failed, no bytes written | nothing, silently |

Clicking "Export CSV" and getting no file and no message is the least
explainable thing an app can do to someone who is not going to open a console to
find out why. There is no diagnostic to report, no place to look, and no way to
tell whether to try again.

One site was worse than silent. The Visual QC PDF button called
`openPrintReportHtml()` — which returned a bare `true` whether the print window
had opened, the HTML fallback had been saved, *or* the fallback had failed or
been cancelled — and then announced:

> Ready. Use "Save as PDF" in the print dialog.

unconditionally. In two of those three cases there was no print dialog on
screen. The app was telling the user to use a thing that did not exist.

### 21.2 The seven sites

| File | Sites | Surface available |
|---|---|---|
| `src/scripts/features/reviews/index.js` | 4 (two menu items, two panel buttons) | none — dialog only |
| `src/scripts/components/visualQcModal/index.js` | 3 (JSON, CSV, PDF) | `setProgress(p, text)` at 1257 |

That second column was measured, not assumed. Grepping `reviews/index.js` for
`setStatus|_setStatus|toast|__toast|setProgress` returns nothing: the panel has
no status strip of any kind, so its only channel is a modal.

### 21.3 Why the module returns a tone, and why there is no `show()` helper

The obvious shape here is a helper that takes an outcome and displays it. It is
the wrong shape, because the two surfaces genuinely differ and not by accident:

- `visualQcModal` **should** report a cancel on its progress line. The line is
  already on screen and the user is looking at it; going blank is worse.
- `reviews` **must not** report a cancel. Its only channel is a popup, and
  interrupting someone with a dialog to tell them their own Cancel button worked
  is noise, not service.

So `saveNotice(outcome)` returns `{ tone, text }` and each call site branches.
`isDialogWorthy(notice)` is the encoding of the asymmetry — true only for
`TONE_ERROR` — and dialog-only surfaces call it before they speak.

### 21.4 Why `SAVED` does not say "Saved to disk"

Because no tier can prove it:

- `chrome.downloads.download` resolves an id when the download is **accepted**,
  not when the bytes land.
- The `showSaveFilePicker` tier writes and closes, which is closer, but the
  cascade does not distinguish it.
- The anchor tier is literally `downloadText(...); return SAVED;` — no callback
  of any kind.

A "Saved to disk" confirmation would have replaced one unverified claim with
another, which would have missed the point of the fix. The sentence shipped
describes the app's side of the handover — *"Export finished."* — which is true
of all three tiers. The test asserts the absence of the stronger claim, so a
future edit cannot quietly upgrade it.

### 21.5 Translate whole sentences

Each of the three outcomes gets one complete sentence through `translate()`,
rather than a stem plus a glued-on clause. The dictionary is keyed on sentences,
and assembling clauses produces word order that is wrong in most of the seven
languages the app ships. This is the same lesson as `friendlyText`'s
`message + ' ' + hint` glue, recorded in audit 19 and still open there.

### 21.6 The gate, and what it checks

`tests-js/saveNotice.test.mjs`, 15 tests in two halves.

**The module** — a distinct tone and a distinct whole sentence per outcome;
`SAVED` not claiming a filesystem state; the cancel sentence naming the cancel;
the failure sentence offering a next step; `isDialogWorthy` true only for a real
failure. And, deliberately, that an **unrecognised** outcome — `undefined`,
`null`, `''`, `0`, `{}` — comes back as an error rather than as nothing.
`undefined` is exactly what a call site would pass if some future cascade forgot
to return, and silence is the one answer that must not be reachable by accident.

**The call sites** — a module returning perfect sentences is worth nothing if a
call site goes back to discarding the outcome, and no unit test of
`saveNotice.js` can see that happen. `discardedCalls()` walks the source for a
call used as a complete statement with no assignment, no `return`, and no
`.then` chain within three lines. It matches the **construct**, not a wording:
enumerating forbidden spellings is guessing at the next mutation, which is the
M7 lesson from audit 20.

### 21.7 Mutation results

Seven mutations, each checked with `diff -q` to confirm it actually landed
before its result was trusted — a mutation that fails to apply proves nothing,
and one did fail to apply on the first attempt here.

| # | Mutation | Applied | Caught |
|---|---|---|---|
| M1 | `btnExportJSON` discards the outcome again | yes | yes (2 tests) |
| M2 | drop the `saveNotice` import from `visualQcModal` | yes | yes |
| M3 | `saveNotice` returns `''` for a failure | yes | yes (3 tests) |
| M4 | `openPrintReportHtml` returns a bare boolean again | yes | yes |
| M5 | the "Save as PDF" line announced unconditionally | **no** — retried | yes, on the retry |
| M6 | `announceExport` alerts on every outcome, cancel included | yes | yes |
| M7 | `visualQcModal` CSV site stops using the progress line | yes | yes |

M5's first attempt was a `perl -0pi` substitution containing the curly quotes
from the UI string; it silently matched nothing. Re-done as a Node script with
an explicit occurrence-count guard, it applied and was caught. This is the
second time in two iterations that a `perl` mutation has failed to apply
silently — the occurrence-guarded Node form is now the default.

All three files were restored and proved byte-identical afterwards.

### 21.8 A gate of iteration 20's had to move

`friendlyAlert.test.mjs` counts `friendlyAlert(` calls per converted file so
that deleting one is a failure rather than a quiet regression. `reviews` moves
4 → 5, because `announceExport()` adds a call inside the new helper. The count
was raised with a comment saying why. The gate did exactly what it was built to
do: it noticed a change to a converted file and made someone justify it.

### 21.9 Out of scope, on purpose

- `pfxPlatform.saveFile` collapses cancel and failure the same way. It has zero
  callers; still deliberately left.
- The anchor tier's evidence-free `return SAVED` in **both** cascades. Making it
  honest needs a real completion signal from the platform layer.
- `openPrintReportHtml`'s `PRINTED` means `window.open` succeeded. It does not
  know whether the print dialog actually appeared.
- The three new sentences have no dictionary rows in the seven locales, so
  `translate()` falls back to English. Recorded, not guessed at.

### 21.10 Deploy

`npm run build-verify` exit 0 after the commit (the two `selfContained.test.mjs`
failures present beforehand are the new-untracked-file gates, and clear once the
files are in the index — the gate working, not a flake). `npm run build:renderer`
exit 0, 375 files. Committed as `ac1840a`, five files, verified with
`git show --numstat` to carry no foreign hunks; the user's 6/6 in
`reviews/index.js` were confirmed intact afterwards. A signed/notarized
`npm run build:mac` needs the user's Apple credentials and pushes an artifact
outward; it has not been authorized and was not run.

## Audit 22 — a comment that reasoned about CSS it never read

Audit 21 closed with a line on the still-open list: *"The three new sentences
have no dictionary rows in the seven locales."* That is one half of this audit.
The other half started as a note in `friendlyAlert.js` and turned out to be the
more interesting finding, because the note was wrong.

### 22.1 The advice ran on from the end of the path

`friendlyText()` is what every one of the ~66 `showError()` call sites reaches
through, since `errorBanner.js` humanizes at the display boundary. It joined a
rule's `message` and its `hint` with a space. Two of the sixteen rules end their
message with a filesystem path — the ENOENT rule builds
`` `${_t("That file or folder couldn't be found:")}\n${p}` `` — so on those two
the space join produced:

```
That file or folder couldn't be found:
/Volumes/SHOW DRIVE 01/reel3/A003C012.ari Check that it still exists and…
```

A post-house volume name has spaces in it. Nothing in that line tells a reader
where the path stops and the advice starts, and the path is the one part of the
message an assistant is actually meant to act on. ENOENT is also the single most
common failure this app produces: a drive that is not mounted.

### 22.2 The comment was the bug's cover story

Iteration 20 added a paragraph to `friendlyAlert.js` explaining why the alert
composes from `friendlyError()` PARTS rather than post-processing
`friendlyText()`. It went on to assert that the banner could not be fixed the
same way, because it "renders through `textContent` with default `white-space`,
where a newline collapses to a space anyway — fixing that one needs CSS, not a
different join."

`.pfx-error-banner` in `src/styles/main.css:55999` has carried
`white-space: pre-wrap` since `d0ab098` — the commit that created the banner.
The CSS half was never missing. Only the join was.

The comment was written from a reading of `errorBanner.js` alone: `el.textContent
= msg` is there in plain sight, and the conclusion follows from it *if* you
assume the default. Nobody grepped the stylesheet. A comment that reasons about
code it has not read is a comment that can be confidently, durably wrong, and
this one had been sitting for two iterations telling the next reader not to try.
It is corrected in place rather than deleted, because the correction is the more
useful artifact.

New species: **comment-asserting-unread-CSS** (1 site, fixed). The general form
is a comment that reasons about a *different file's* behaviour without citing
it. Worth a sweep later; not attempted here.

### 22.3 The inline rule, and why it is not redundant

`errorBanner.js` now also sets `el.style.whiteSpace = 'pre-wrap'` on the banner
it mounts. That looks like a duplicate of the stylesheet until you note why the
banner mounts itself in the first place: `src/index.html` is not shared by the
extension target or by the bwav/preflight tool pages, and **no tool page links
`main.css`**. On those hosts the newlines would collapse and the defect would
come back on exactly the surfaces nobody checks. Same reasoning that already put
`opacity` inline. A host-supplied `#errors` is left untouched — that slot owns
its presentation, which is the point of deferring to it.

### 22.4 Three sentences no locale had

`core/saveNotice.js`, added last iteration, localises its three ending sentences
through `friendlyError`'s exported `translate` shim. It shipped with **zero**
rows in `ERROR_DICT` for all six non-English locales. Every Korean, Japanese,
Traditional Chinese, Thai, Indonesian and Filipino user read "Export finished."
in English.

`errorI18n.test.mjs` exists precisely to make that loud. It did not fire, because
it scans `friendlyError.js` and nothing else. **A gate that scans one file cannot
notice a second file borrowing the same shim.** The gate now scans
`saveNotice.js` through its own extractor — the shim is spelled `translate(` there,
not `_t(`, and widening the existing regex would have started matching the
`_t as translate` re-export.

The two edits are coupled and had to land together: adding rows to `ERROR_DICT`
alone trips the gate's own orphan test, which compares `Object.keys(DICT.ko)`
against a `STRINGS` set derived from `friendlyError.js` only.

18 rows added (6 locales × 3 sentences). They are machine-authored, and go on the
same native-speaker list as the 486 in `UI_DICT_ROWS`.

### 22.5 What was measured before editing

- `friendlyText` has exactly one consumer: `errorBanner.js:53`, via `humanize()`.
- `showErrorBanner` has exactly one caller: `src/scripts/ui.js:3288`.
- No tool page links `main.css`; none mounts the banner today.
- All six target files were clean in the worktree, so no reconstructed blobs were
  needed. `src/styles/main.css` is 301/326 dirty with the user's work and was
  **read only** — the `pre-wrap` it needs was already there.

### 22.6 Gates

`errorBanner.test.mjs` +93 lines: one raw string per rule (16 samples, ≥14 must
match a rule carrying advice, so the loop cannot pass by never running) asserting
`friendlyText(raw) === message + '\n' + hint` and that the advice appears on no
earlier line; the three-line shape of the file-not-found case with a
space-containing volume name; the inline `pre-wrap`; that a host-supplied
`#errors` is *not* given one; and `white-space: pre-wrap` in the stylesheet rule
itself.

`errorI18n.test.mjs` +36 lines: the `saveNotice.js` scan, its merge into
`STRINGS`, the `>= 45` → `>= 48` threshold, and a three-sentence spot-check —
without which a half-broken second scan would let every coverage test below it
pass vacuously.

### 22.7 Mutation testing

Seven mutations, all applied with the occurrence-guarded Node form and all
restored byte-identical:

| mutation | caught by |
| --- | --- |
| `friendlyText` joins with a space again | errorBanner |
| the inline `pre-wrap` is dropped | errorBanner |
| the stylesheet stops honouring newlines | errorBanner |
| a locale loses one of the new rows | errorI18n |
| a locale stubs a row with the English | errorI18n |
| the `saveNotice` scan quietly matches nothing | errorI18n |
| `saveNotice` grows a fourth sentence with no rows | errorI18n |

7 applied, 7 caught, 0 survived. Two of the seven were setup-failures on the
first pass (a Korean value written as `\uXXXX` escapes in the harness, where the
file holds the characters literally) — reported as `SETUP-FAIL`, not as a pass,
which is the whole reason the occurrence guard is there.

### 22.8 Still open

- The 18 new translations are machine-authored.
- The anchor tier's evidence-free `return SAVED` in both cascades, unchanged.
- `openPrintReportHtml`'s `PRINTED` still only means `window.open` succeeded.
- The general **comment-asserting-unread-CSS** sweep has not been run.
- `_path()` still truncates an *unquoted* path at its first space. Every observed
  ENOENT string quotes the path, so this is latent, not live — recorded, not
  guessed at.

### 22.9 Deploy

`npm run build-verify` exit 0 (250 passed, 7 skipped; XSS, XXE and fail-open
gates clean). `npm run build:renderer` exit 0, 375 files. Committed as `1b80df1`,
six files, `git diff --cached --summary` empty and `git show --stat` confirming
no foreign hunks. A signed/notarized `npm run build:mac` needs the user's Apple
credentials and pushes an artifact outward; it has not been authorized and was
not run.

## Audit 23 — Settings › Resolve Engine (`smart_engine_settings.js`)

**23.0 The opening lead was wrong, and measuring is what showed it.** Iteration
22 left `_path()`'s unquoted-path truncation on the backlog as latent. Grepping
turned up four in-repo producers of exactly that shape —
`electron/ipc.js:853/854`, `electron/native/media_engine.js:184`,
`electron/native/native_router.js:115`, `electron/imf/imf_frame_provider.js:828`
— all `not found: <unquoted path>`, which looked like the lead going live.
Tracing the wire end to end killed it: `imf_ui.js:995` prints
`FAILED · ${result.code}` and `smart_engine_settings.js` printed
`FAILED: ${msg}`, and **neither routes through `friendlyError`**, so `_path()`
never sees those strings. The finding stays latent and stays on the backlog.
All four producers are also the user's uncommitted work, so they were
uncommittable regardless. Reading the two surfaces to disprove the lead is what
surfaced this iteration's real target — worth recording as method, not luck.

**23.1 A write to a fixed channel, read back from the active one (CONFIRMED,
FIXED).** `repairEngines()` assigned `_logsData['playback']` and then called
`_renderActiveLogTab()`, which resolves its channel from
`#smartEngineLogsTabs .smart-log-tab.is-active`. `index.html:4273-4276` defines
four tabs — playback, imf, proxy, resolve — with playback default-active. So on
three of the four the instructions were written to a channel nobody was looking
at and the button was a **silent no-op**; on the fourth it worked by
**destroying the fetched playback log** until the next `showLogs()`. New species:
**write-to-fixed-channel-render-from-active-channel**. Fixed by printing into
the content element and leaving `_logsData` alone, which also means a tab click
returns the panel to real logs.

**23.2 Seven raw-exception status lines, on the screen that exists to answer
them (FIXED).** Lines 91, 139, 145, 198, 204, 250 and 305 wrote `err.message`,
`stderr` or a raw `error` field straight into the panel. This is the panel four
of `friendlyError`'s sixteen hints direct the user to, so it is where somebody
arrives *after* being told in plain language what went wrong — and was handed a
second errno. One site (the proxy catch) had been converted to `friendlyAlert`
in an earlier pass and the other seven left; the file was half-done. Now
`friendlyStatus("<operation> failed: <raw>")` at each. `friendlyStatus`, not
`friendlyAlert`: these are status lines rather than dialogs, and
`friendlyAlert.test.mjs` carries a `CONVERTED` table expecting exactly 1 call in
this file plus a `checked === 7` total, either of which a new `friendlyAlert`
would have invalidated in a coupled edit.

**23.3 The pre-wrap gap recurs at a new surface (FIXED).** `friendlyStatus`
returns message and hint joined by a newline as of iteration 22.
`smartEngineDecodeLabel` (`index.html:4265`) and `smartEngineStatusList`
(`:4250`) are plain `<div>`s with default white-space, where that newline
collapses back into the run-on line iteration 22 removed. Set at the write site
via `_setStatusText`, matching `errorBanner.js`'s reason for doing the same:
the markup is the user's uncommitted work and not editable from here.
`smartEngineLogsContent` is already a `<pre>` with `white-space:pre-wrap`, so
the instructions needed nothing.

**23.4 "Repair Engines" repaired nothing and explained nothing (FIXED).** The
button printed a bare brew list — `brew reinstall ffmpeg`, a comment about
`--enable-libxml2`, `brew install libopenjph  # OpenJPH (ojph_expand)` — to a
reader who had just pressed a button promising the app would fix it. It cannot:
these are system-wide packages needing an admin password in a terminal. The
honest version says what the engines are, that this is copy-and-paste and not
code, how to open Terminal, what to do when `brew` is missing (brew.sh, not a
pipe-to-shell line), that a password prompt shows nothing while you type, and
that none of it touches your footage. Directly the directive's "highly
accessible for non-technical users".

**23.5 `Proxy failed: unknown` (FIXED).** Read as if the app knew a reason and
would not give it. It does not know; it now says so.

**23.6 A comment asserting a behaviour the function does not have (FIXED).**
Header line 12: "Repair Engines → open brew install guide in external browser".
It has never opened a browser — there is no `openExternal`, `shell.open` or
`window.open` anywhere in the file, and the gate now asserts that too, so
whichever of the two is wrong in future, one of them fails. Sibling of
iteration 22's **comment-asserting-unread-CSS**, one step further along.

**23.7 English-literal-as-control-flow (FOUND, NOT FIXED — backlog).**
`init()` gates its auto-check on `list.textContent.includes('Check Engines')`,
matching the placeholder authored at `index.html:4251`
(`Click "Check Engines" to scan…`). Presentation text used as control flow. It
survives today only because that placeholder carries no `data-i18n` and is not
an `i18n.js` dictionary key — translate the panel and the auto-check dies
silently. `resolve_engine_panel.js`'s mirrored listener has no such guard, so
this is a singleton, and fixing it means touching `index.html`. Recorded.

**23.8 Three untranslated `alert()` calls (FOUND, NOT FIXED — backlog).** Lines
102, 158, 217, all guarded by `!_isElectron()` and therefore unreachable in the
desktop build. Low value; recorded rather than fixed to keep the iteration
scoped.

**Verification.** `tests-js/smartEngineSettings.test.mjs`, 13 tests, drives the
real exported `init()` against a fixture rather than calling internals —
`repairEngines` and the tab handler are half of what went wrong, so exercising
the wiring is the point. The fixture's ids and the four-tab order are asserted
against `src/index.html`, so a fixture that drifts fails rather than testing a
panel the app does not have. The raw-error scan enumerates constructs, not
today's wordings, and carries a `hits.length >= 5` floor so it cannot pass by
matching nothing — the failure mode that fooled iterations 20 and 21. Verified
the gate fails under the plain `node <file>` invocation `test:js` actually uses,
not just `node --test`. 8 mutations applied, 8 caught, all files byte-restored.
`npm run build-verify` exit 0, `npm run build:renderer` exit 0 (375 files,
v2026.6.1). Committed as `0ee334d`, two files, `git diff --cached --summary`
clean of mode changes (`smart_engine_settings.js` is 100644 at HEAD with an
uncommitted 100755 mode change in the user's tree, so it was staged with
`git add --chmod=-x`). A signed/notarized `npm run build:mac` needs the user's
Apple credentials and pushes an artifact outward; it has not been authorized
and was not run.

## Audit 24 — the print dialog that was announced before it was asked for

**Finding 1 — success-returned-before-the-attempt.**
`src/scripts/components/visualQcModal/index.js`, `openPrintReportHtml`. The
print branch scheduled `w.focus(); w.print()` on a 300 ms `setTimeout` inside a
swallowing `try/catch` and returned `PRINTED` immediately. Nothing in the
function ever observed the outcome it was reporting. Four reachable failures —
a pop-up blocker returning a window it closes, the user closing it during the
layout delay, `print()` throwing, `print` absent — all produced the success
path, and the caller announced *"Ready. Use “Save as PDF” in the print
dialog."* with no dialog on screen. Severity: this is the wording defect
`core/saveNotice.js` exists to prevent, surviving in the function that
iteration 21 partially fixed.

**Finding 2 — unverified-disk-claim at a site that bypasses saveNotice.**
Same function, fallback branch: *"Report saved as HTML."* Every other export
route in the app goes through `saveNotice()`, whose SAVED sentence deliberately
describes the handover and not a filesystem state, because no tier of the
cascade can prove the bytes landed. This was the one site that did not, and so
the one site still claiming it.

**Finding 3 — test-fixture-passing-for-the-wrong-reason.** In the new
`tests-js/printOutcome.test.mjs`, `fakeWindow` applied overrides with
`Object.defineProperties(win, Object.getOwnPropertyDescriptors(over))`. `over`
was already a descriptor map, so `getOwnPropertyDescriptors` wrapped each entry
in a second descriptor and `win.print` became the object `{value: fn}`, `closed`
became `{get: fn}`. Five tests passed against a window that was not the window
they described. Both readings happen to be OPENED/CLOSED, so the assertions
were green and vacuous. Detected only by the mutation harness — two mutations
it should have caught were missed. Correct form is
`Object.defineProperties(win, over)`; a self-check test now asserts all five
descriptor shapes produce the object the tests assume.

**Finding 4 — two stale claims in a "what this cannot see" list.**
`tests-js/saveNotice.test.mjs`'s header listed the print dialog and the missing
dictionary rows as known blind spots. Both had been closed by this iteration.
They are now recorded as closed rather than deleted, because "we know we cannot
see this" and "we checked" are different states.

**Fix.** New `src/scripts/core/printOutcome.js` (133 lines) with `PRINTED`,
`OPENED`, `CLOSED`, `tryAutoPrint(win, {delayMs = 300, wait})` and
`printNotice(outcome)`. `tryAutoPrint` awaits the delay and *then* inspects the
window; `printNotice` owns the three print endings and delegates save outcomes
to `saveNotice` so one situation has one wording. The call site collapsed from
a three-way `if` to `const notice = printNotice(how)`. `CLOSED` falls through
to the file save — a behavioural improvement, not only better wording. 18
`ERROR_DICT` rows added for the three sentences across all six locales.

**Verification.** `tests-js/printOutcome.test.mjs`, 25 tests: the three endings,
the delay actually elapsing before any print (a held promise proves nothing was
printed early), the clock receiving the caller's delay, the fixture self-check,
plus source gates over the call site scoped to the export-PDF handler — the
first draft of that gate flagged two *legitimate* `setProgress(1, …)` lines and
was wrong, not the code. `tests-js/errorI18n.test.mjs` extended to 22 tests
with the `SCANNED` table. `tests-js/saveNotice.test.mjs`'s two assertions
written against the old bare-`true` contract were rewritten against the new one
rather than deleted. **21 mutations applied across two harnesses
(`/tmp/mut24.mjs` 15, `/tmp/mut24b.mjs` 6), 21 caught**, all files
byte-restored. `npm run build-verify` exit 0, `npm run build:renderer` exit 0
(376 files, v2026.6.1). Committed as `5a1f8d6`, six files, `git diff --cached
--summary` clean of mode changes. A signed/notarized `npm run build:mac` needs
the user's Apple credentials and pushes an artifact outward; it has not been
authorized and was not run.

## Audit 25 — `raw-exception-in-status-line`, counted properly this time

**The species was undercounted.** It had been tracked as 22 occurrences with 20
fixed. A construct-based sweep across all of `src/` —
`(textContent|setProgress|setStatus|_setStatusText)` receiving
`err?.message`/`err.message`/`String(err)`, minus anything already wrapped in
`friendlyStatus` — returns **17 remaining**, not 2. The earlier count was of the
files that had been looked at, not of the codebase.

    6  src/scripts/features/trlconf/index.js
    4  src/scripts/features/reviews/index.js
    3  src/scripts/modules/imf/imf_ui.js
    2  src/scripts/prep_mark.js
    1  src/scripts/features/user/index.js
    1  src/scripts/features/cutdiff/index.js

**All six of those files are the user's uncommitted in-flight work** (`git
status` reports ` M` for every one), so none of the 17 can be fixed under the
commit-only-what-this-iteration-touches policy. This is not a deferral for lack
of time; it is a hard block, and it is why the two sites in
`visualQcModal/index.js` — the only file in the species that was clean at HEAD —
were the ones taken. Worst of the blocked set by user impact:
`features/user/index.js:357` (`errEl.textContent = err.message`, a raw exception
on the sign-in card) and `features/cutdiff/index.js:6626`
(`"Error: " + (err?.message || String(err))`).

**A second, quieter finding: the fix has two halves and the second is easy to
miss.** Six call sites in `smart_engine_settings.js` already route through
`friendlyStatus`, and every one of them lands via `_setStatusText`, which sets
`white-space: pre-wrap` — or, at line 105, via an inline
`style="…white-space:pre-wrap;"`. `errorBanner.js` does the same. That is three
independent places that discovered the newline collapse and handled it locally,
and one — `visualQcModal` — that would have hit it the moment it adopted the
pattern. **Adopting `friendlyStatus` at a new site is not a one-line change**;
it is a two-line change, and the second line is invisible unless you know the
function returns two lines. Recorded here so the next adopter does not have to
rediscover it, and gated in `tests-js/visualQcStatus.test.mjs` for this
component.

**Limit of the fix, stated rather than hidden.** `friendlyStatus` rewrites only
what its rules table matches. `Visual QC scan failed: NotAllowedError: play()
failed` comes out unchanged apart from the prefix, and a permission or decode
error is a plausible Visual QC failure. The gate's header says so; widening the
rules table means six new locale rows per rule and a bump to
`errorI18n.test.mjs`'s `SCANNED` counts, which is its own iteration.

**Verified.** 7 new tests, **10 mutations applied, 10 caught**
(`/tmp/mut25.mjs`), file byte-restored. `npm run build-verify` exit 0, `npm run
build:renderer` exit 0 (376 files, v2026.6.1). Committed as `32271b4`, two
files, `git diff --cached --summary` clean of mode changes. A signed/notarized
`npm run build:mac` needs the user's Apple credentials and pushes an artifact
outward; it has not been authorized and was not run.

## Audit 26 — error-with-no-rule-passes-through-verbatim

**Species.** A classifier is only as good as its table. `friendlyError` has had
sixteen rules and a full six-locale dictionary since iteration 22, and every
iteration since has been routing more call sites into it — which quietly made
the table's *coverage* the whole remaining problem. Its rules were written
against Node and ffmpeg: errno codes, decoder complaints, `Failed to fetch`.
Nothing in it spoke DOM.

**Measured, not assumed.** Thirteen exception strings, each one traced to the
line of this repo that produces it, run through the real function
(`/tmp/probe26.mjs`): **13/13 fell through**. The worst is not hypothetical —
Visual QC reads every frame it measures with `getImageData`, and iteration 25
had just finished routing that strip through `friendlyStatus`, so a tainted
canvas gave a colourist a clean two-line layout containing
`SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D'`.
Presentation without classification.

**Finding: `AbortError` is ambiguous in this codebase and must not be reported
as a cancellation.** Three sites (`features/reviews/index.js:141`, `ui.js:15413`,
`features/tl_convert/index.js:1856`) check the name to mean *the user dismissed
a picker* — reviews even says so in a comment. Eight others arm
`setTimeout(() => ctrl.abort())` on a fetch (`auth/policyApi.js:33`,
`features/trlconf/index.js:191`, `workers/renderWorkerClient.js:22` and `:36`,
`modules/proResProxy.js:480`, `components/annotateModal/index.js:1659`,
`modules/imf/imf_player.js:5367`, `modules/imf/imf_ui.js:8093`), and several
more use `AbortSignal.timeout()`. The DOM hands back the same sentence for all
of them. From inside `friendlyError` the two are indistinguishable, so any
wording that asserts intent is wrong most of the time. The rule states only
what holds in both cases. This is the kind of finding that only surfaces by
counting call sites; the plausible rule was already written when the count
killed it.

**Finding: rule cost is asymmetric, and it should drive scope.** Widening an
existing regex costs nothing to translate. A new rule costs eighteen rows.
Five candidates, three rules, two widenings — 36 rows not spent on advice that
would have been word-for-word identical. Recorded because the instinct is to
give every distinct exception its own entry, and the user-visible result of
doing so is a dictionary that is harder to have reviewed by a native speaker
for no gain in what anyone reads.

**Two exceptions deliberately left raw.** `QuotaExceededError` and
`NotReadableError`. prep_mark handles the quota case locally at 4113 and the
microphone path has its own handler, so neither rule could fire. Stating this
is the point: an audit that lists 13 findings and 13 fixes when two of them
were unreachable has inflated its own numbers.

**Two mutations escaped the first gate, and that is the useful part.** The
harness re-added the bare `cross-origin` alternative — the exact alternative
dropped during design — and the gate passed, because the CORS string chosen for
the test says "CORS policy", not "cross-origin". A second miss showed the
ordering assertion could not fail: the EACCES rule and the NotAllowed rule
share no words today, so *moving* them proves nothing; what would actually
regress is someone widening NotAllowed by one plausible word. Both assertions
were rewritten against measured strings. **11/11 caught** on the second run.
A gate written from intent rather than from a mutation that must fail it is a
gate that tests its author's memory.

**Verified.** 21 new tests, 11 mutations applied and 11 caught
(`/tmp/mut26.mjs`), file byte-restored. `errorI18n` floor 48 → 62.
`npm run build-verify` exit 0, `npm run build:renderer` exit 0 (376 files).
Committed as `2f3601e`, five files, `git diff --cached --summary` clean of mode
changes, dirty count unchanged at 693. A signed/notarized `npm run build:mac`
needs the user's Apple credentials and pushes an artifact outward; it has not
been authorized and was not run.

## Audit 27 — a false diagnosis is worse than no diagnosis

**Finding.** `src/scripts/modules/proResProxy.js` reported *every* unrecognised
proxy failure as "unsupported codec". Measured against the six ways
`getProxyStreamUrl` rejects, that was true in one case and false in five. The
class is **misdiagnosis-as-fallback-branch**: a default arm that asserts a
specific cause instead of admitting it does not know one. It defeats the usual
defence against vague errors — the user *believes* it, and acts on it.

**Severity, in hours.** A colourist told "unsupported codec" re-transcodes the
plate. That is the wrong action for a companion that needed restarting
(`host_unavailable`), a drive that unmounted (`input_missing`), a full disk
(`ENOSPC` via `data.error`), and a 30-minute cap that PostFlowX itself imposed
(`transcode_timeout`). Four of those are fixed in under a minute once named.

**What is now measured** (all verified, exit 0):

| rejection | source | now says |
|---|---|---|
| `host_unavailable` | proResProxy:422 | native helper not available (Browser Mode only) |
| `upload_failed_NNN` | proResProxy:466 | the file could not be handed to the media helper |
| `transcode_timeout` | proResProxy:477 | the conversion took too long and was stopped |
| `progress_fetch_failed` | proResProxy:494 | the media helper stopped responding |
| `TimeoutError` (10 s poll) | proResProxy:487 | the media helper stopped responding |
| `ffmpeg_missing` | pfx_host:159 | ffmpeg not found on this machine |
| `input_missing` | pfx_host:162 | the source file could not be found — it may have moved |
| `ENOSPC` / `EACCES` | `data.error` | via friendlyError: disk full / permission |
| `Unsupported codec in stream 0` | ffmpeg | This media couldn't be decoded. **(still says so)** |
| anything unrecognised | — | this file could not be converted for preview |

The codec claim was made narrower, not deleted. When ffmpeg itself says the
codec is the problem, PostFlowX still says the codec is the problem.

**The withdrawn mutation.** A twelfth mutation — deleting the
`transcode_timeout` rule — did **not** fail the gate. The honest reading is that
the gate is right: `friendlyError` independently classifies that token as
"That took too long and timed out.", so the dedicated rule is a wording upgrade
(it names the cap as something PostFlowX did) rather than the only thing between
the user and a false message. Forcing a catch would have meant pinning exact
wording, which fails on any honest rephrasing. The mutation was removed and the
reason written into the test's own "WHAT THIS CANNOT SEE" block. A mutation
harness that is edited until it reports 12/12 is measuring the author's
persistence, not the gate.

**Disclosed, not claimed.** `host_timeout` and `file_not_found` sit in the rule
table but are **not** produced on this file's measured path — `host_timeout`
comes from `imf_proxy.js:84-85`. Both share a regex alternative with a reachable
token, so each costs zero dictionary rows; they are cheap insurance, and the
test says so rather than counting them as coverage.

**Not fixed, with reasons.** `imf_ui.js:8895-8897` has the identical ternary
shape and is the obvious next target, but the file carries 12/6 of the user's
in-flight work. `renderWorkerClient.js:22/:36` was examined and excluded as
speculative — nothing in the tree consumes `window.PFX_RENDER_WORKER`, so
rewiring its abort would be a change with no reachable user. `annotateModal:1659`
and `imf_player.js:5367` swallow their aborts into `return null` and
`console.warn` respectively; naming them buys nothing today.

**Verified.** 18 new assertions, 11 mutations applied and 11 caught
(`/tmp/mut27.mjs`), source byte-restored. `errorI18n` floor 62 → 69, scanning
three files now. `npm run build-verify` exit 0, `npm run build:renderer` exit 0
(376 files). Committed as `483e2f5`, four files, `git diff --cached --summary`
clean of mode changes. The 42 new ERROR_DICT rows are machine-authored and want
a native-speaker pass. A signed/notarized `npm run build:mac` needs the user's
Apple credentials and pushes an artifact outward; it has not been authorized and
was not run.

## Audit 28 — a guard that fires on your own new rows is the guard working

`npm run build-verify` went red on `errorI18n.test.mjs`:

```
no dictionary entry is left behind after a rule is reworded
  in ERROR_DICT but in none of the scanned sources:
    mpv is not installed on this machine
    the mpv player did not start
    ... (all six iteration-28 keys)
```

Not a false positive. That check was written in an earlier iteration with a
comment saying exactly this: *"rows added for a module nobody remembered to
list in SCANNED look exactly like dead keys from here."* Six brand-new rows and
six dead rows are indistinguishable from inside the dictionary, so the check
cannot tell them apart and should not try. The fix is the one it was asking
for: add `core/playableMedia.js` to `SCANNED` with `expected: 6`.

Worth recording because the tempting move — loosening the orphan check to
ignore recently-added keys — would have deleted the only mechanism that
notices a module shipping English to six locales.

### What was measured, not assumed

The corpus for `_playbackFailReason` is not invented. Every rejection is cited:

| Rejection | Thrown at | Now says |
|---|---|---|
| `mpv not found. Install mpv: brew install mpv` | `mpv_engine.js:109` | mpv is not installed on this machine |
| `MPV socket not created at …/mpv-N.sock within Nms` | `mpv_engine.js:99` | the mpv player did not start |
| `MPV open failed` | `mpvPlayer.js:52` | the mpv player did not start |
| `MPV IPC error: …` | `mpv_engine.js:80` | the mpv player did not start |
| `EACCES: permission denied, open '…'` | OS, via friendlyError | a permission message |
| anything else | — | this file could not be opened for playback |

The second row is the finding. Under the old ternary it produced
`Direct ProRes playback failed (MPV socket not created at
/var/folders/qq/T/mpv-3.sock within 4000ms). Create proxy fallback?` in a
status strip sized for one short line.

### The `_pfxNativeAttempted` reading

`grep -n _pfxNativeAttempted` gives three sites: set `false` at `:177`, set
`true` at `:240`, read at `:338`. `:240` is the first executable statement of
`_startNativeAVPath`, before `mountNativeCanvas`, before `engine.open`. So the
flag means *tried*, not *failed to decode*. A gate floor now slices the function
head and asserts the assignment is still there, so if someone moves it into the
`.catch` — where it would genuinely mean the engine failed — the suite says so
and the wording can be revisited rather than left conservatively vague forever.

### Not fixed, with reasons

- `imf_ui.js:8895-8897` — the same ternary species. `src/scripts/modules/imf/imf_ui.js`
  is ` M` with the user's in-flight work (12 added / 6 removed). Blocked.
- Site 3's token-race: `onProxyFail` is called directly at `:443` rather than
  through the guarded forwarder at `:477`, so a hint can land after the user
  moved to another clip. Fixing it means changing control flow, not wording, and
  that is a separate change with its own risk. Disclosed in the test's
  "WHAT THIS CANNOT SEE" rather than quietly folded in.
- `'path required'` and `'Unknown sessionId'` in `mpv_engine.js` are programmer
  errors on paths `open()` does not reach. No rule, deliberately — a rule for an
  unreachable rejection is a rule nobody can ever verify.

### Mutation result

11/11 caught, source byte-restored. All eleven are live; unlike iteration 27
nothing had to be withdrawn, because each rule here is the only thing standing
between its rejection and the catch-all — `friendlyError` recognises none of
the MPV tokens.

## Audit 29 — translating a label is not free

### The finding

Translating the two `friendlyStatus` labels — the correct fix for
`untranslated-label-in-front-of-a-translated-message` — immediately produced a
new defect in Japanese.

`friendlyStatus` keeps a `"<label>: "` prefix only when the string matches
`src/scripts/core/friendlyError.js:331`:

    /^([^:]{1,40}\s[^:]{0,40}):\s+([\s\S]+)$/

That regex **requires a whitespace character in the label**. When it does not
match there is no error and no warning: the whole string falls through to
`friendlyText(s)` and the prefix is gone. Japanese does not put spaces between
words.

Measured, not reasoned — all twelve translated cells run through the real
`friendlyStatus`:

| result | cells |
|---|---|
| prefix kept | 10 |
| prefix silently dropped | **2 — both `ja`** |

`"ビジュアルQCスキャンに失敗しました"` and `"PDFレポートの書き出しに失敗しました"`.
A Japanese colourist would have read the disk-full message with nothing saying
which operation produced it — precisely the loss the prefix exists to prevent,
reintroduced by translating the prefix.

**Fix.** Both `ja` cells now put a space either side of the Latin acronym:
`"ビジュアル QC スキャンに失敗しました"`, `"PDF レポートの書き出しに失敗しました"`.
This is ordinary Japanese typography for an embedded Latin run (和欧間スペース),
so it reads correctly — but the honest reason it is there is that a regex needs
it, and the test comment says exactly that rather than dressing it up as a
translation improvement. **This wants a native-speaker check like every other
machine-authored row in this run.**

### The species: gate-that-only-checks-the-English-path

`visualQcStatus.test.mjs` has had the assertion
`the prefixes actually survive friendlyStatus` since an earlier iteration, with
a comment describing this exact hazard. It could not fail. It tested English,
and English always has spaces. The check only became *reachable* for the other
five locales at the moment the label was translated.

A gate written against English literals cannot see the localised failure mode.
Added: `the prefixes survive friendlyStatus in every language, not just
English`, which reads the key out of the `translate()` call in the source, finds
its `UI_DICT_ROWS` row, and pushes **every cell of every locale** through the
real `friendlyStatus`. The next translation that runs its words together fails
here instead of shipping.

### Also corrected

That test's own comment claimed `friendlyStatus` allows "at most 40 characters
before the colon". The regex allows 40 + the whitespace + 40 = **81**. A
65-character label was mutated in to check — it did **not** fail
`visualQcStatus`, correctly, and it *was* caught by `visualQcProgress`'s 60-char
strip-width cap. A mutation that does not fail a gate is not automatically a
hole; here it was a wrong number in a comment, which is now right.

### Mutation result

9/9 caught across `visualQcModal/index.js` and `i18n.js`, both restored
byte-for-byte. Plus 2/2 on the Japanese spaces and 1/1 on the over-long label
via the correct gate. Not counted as 12/12: the third harness run was a
diagnosis, not a gate hole.

### Still open

- Every other `friendlyStatus` call site's label needs the same unspaced-label
  sweep. This iteration only proved visualQcModal's two.
- `friendlyStatus` could be made to accept a label with no whitespace at all
  rather than requiring call sites to insert one. That is a change to shared
  error-rendering behaviour used by seven modules, with its own blast radius,
  and it is not being made at the tail of a loop run on the strength of one
  language. Recorded here so the option is visible.

---

## Audit 30 — the Preflight label config, and three errors of my own

### New species

**`untranslated-alert-in-a-translated-pane`** — 8 sites, all fixed.
`src/tools/preflight/app/app.js` had nine `alert()` calls. Exactly one read a
label from config; eight were English literals, and five of those appended an
exception's own text. The pane around them ships ~148K of translated check
content in seven locales and its renderer follows the label convention at
nineteen sites. The single conforming call site is the evidence: this was not a
decision to ship English, it was a convention that never crossed from the
renderer into the controller.

**`key-read-by-code-but-absent-from-config`** — 2 keys, both fixed.
`drop_hint` is read at `ui.js:419` and existed in none of the seven configs.
`views` is read at `app.js:411` (`L.views || "Views"`) and existed only in `fil`
(`"Mga view"`). Both silently served the English fallback in every language.
This species is invisible in English review, because in English the fallback and
the correct string are the same bytes — the defect only has a visible shape in
the other six languages.

**`orphaned-config-label`** — 10 keys, recorded, not changed.
Present in config, read by nothing: `assign_to`, `assigned_all_run_again`,
`assigned_all_run_again_plural`, `choose_asset_first`, `confirm_done`,
`filter_blockers`, `filter_missing`, `filter_warnings`, `only`,
`ready_to_deliver`. Corrected figures for the Preflight label block: **28 read /
10 orphaned / 2 read-but-absent.** An earlier pass of mine reported 27 orphaned;
see below for why that number was wrong and must not be repeated.

**`locale-asymmetric-config`** — 5 keys, recorded, not fixed.
`assign_to`, `filter_blockers`, `filter_missing`, `filter_warnings`,
`ready_to_deliver` exist in `en` and `fil` only. All five are also orphaned, so
they are inert today. Deliberately not machine-translated: adding five languages
of translation to keys no code reads would make the config look more complete
while making it less true. Recorded so whoever wires them up knows the other
five locales are missing.

### Three errors of my own, all caught by the gate I was writing

Worth recording plainly, because the gate's first useful catches were its author,
and that is the outcome a gate is supposed to have.

**`helper-strip-regex-that-misses-the-last-object-property`.** My English-literal
detector strips helper calls before scanning for bare strings, with a trailing
lookahead of `(?=[,)\];]|$)`. Several of these calls are the *last property of an
object literal*, so what follows the closing paren is ` }` — not a comma. The
strip silently failed on `app.js:943` and the helper's own English fallback was
reported as untranslated English. Correct class: `(?=[,)\];}]|$)`.

**`count-of-mentions-mistaken-for-a-count-of-invocations`.** I derived the number
of folder pickers by counting lines matching `showDirectoryPicker`, which found
three: a comment mentioning it, a `typeof … === "function"` feature test, and the
actual `await`. Only the last can throw. I had excluded the `typeof` lines and not
the comments. Correct matcher: `/await\s+window\.showDirectoryPicker\s*\(/` with
comment lines stripped first.

**`comment-asserting-behaviour-the-function-lacks`, fifth occurrence this run —
this time in my own header.** `paneText.js` claimed "Three call sites filter
`e?.name === "AbortError"`". There are two, at `app.js:349` and `:1107`. The gate
caught it, and the fix was to name the two functions (`rescanFolderAndRun`,
`onPickForReq`) rather than state a count, and to have the test derive the
expected guard count from the picker count in source instead of hardcoding it.
A comment that states a number ages badly; a comment that names the code does not.

### And one process error, from the previous segment

**`format-normalised-by-a-round-trip`.** My first script for adding 174 config
cells parsed each JSON file, added keys, and re-serialised with
`json.dumps(indent=2)`. The diff came back 199 insertions / 25 deletions instead
of the expected additions-only shape. Grepping every deleted line showed why:
five of the seven configs (`id`, `ja`, `ko`, `th`, `zh-TW`) indent part of their
`buttons` block with a literal TAB followed by six spaces, and `fil` alone ends
with a trailing newline. A round-trip destroys both.

Reverted and redone as a textual insert: locate the `"labels": {` body by
counting braces, read the indent from the last existing label line, splice the
new rows in before the closing brace, then re-parse the result as JSON to prove
the splice is valid. Final diff: **181 insertions / 7 deletions**, the seven
deletions being the previous last-label lines re-emitted with a trailing comma.

The general rule: **a JSON round-trip is not a safe way to add a key to a
hand-maintained config file.** And the only way to see that it wasn't safe is to
read every deleted line in the diff, not the insertion count.

### Verification

`tests-js/preflightPaneVoice.test.mjs`, 17 tests, mutation-proven 16/16 with all
files restored byte-for-byte. `npm run build-verify` exit 0 (the new gate is
picked up by the runner without configuration); `npm run build:renderer` exit 0,
377 files.

### Still open

- 174 machine-authored cells here, 829 across this run, all wanting a
  native-speaker pass. This number should be reported every time, not amortised.
- The 10 orphaned keys: either the code should read them or the config should
  drop them. Not a decision to take at the tail of a loop run.
- `src/tools/visionscope/*` (app.js 227 lines, popup.js 212) has no i18n of any
  kind. Clean files, unblocked, a good candidate for the next iteration.
- `visualQcModal/index.js:1470`/`:1477` — `seekTo`'s bare `'Seek failed'` /
  `'Seek timeout'`. Still the cheapest remaining fix in the codebase.

## Audit 31 — the cheapest remaining fix, and the trap it's named after

### New species

None. This iteration closed the one item Audit 30 flagged as still open, and
did it by the numbers the last two iterations established: a rule in
`friendlyError.js`, six locales of `ERROR_DICT` cells, a mutation-proven test.

### One near-miss, avoided by the gate that exists for exactly this

`tests-js/errorI18n.test.mjs`'s own header warns that a rule can be added to
`friendlyError.js`, watch its own dedicated test file go green, and still have
shipped an English-only error to six locales — because `friendlyErrorRules.test.mjs`
only checks classification, not translation coverage. That is precisely what
happened here on the first pass: the new "Seek failed" rule and its three
strings went in, `friendlyErrorRules.test.mjs` passed 27/27, and only
`npm run build-verify`'s full run surfaced `errorI18n.test.mjs` failing six
locale-coverage tests plus the product-name-preserved test — buried early in a
3600+ line `test:js` log because it sorts alphabetically ahead of most other
suites in `tests-js/`. A first grep pass over the log missed it by only
searching the tail; the fix was a broader grep for `AssertionError` across the
whole log, not a narrower one.

No code defect here — the gate did exactly its job. Recorded because it is the
second time in this run a real failure hid in the middle of a long
alphabetically-sorted log rather than at the end, which says the failure-finding
habit (grep the tail) needs to change, not the gate.

### Verification

`tests-js/friendlyErrorRules.test.mjs`: 27/27. `tests-js/errorI18n.test.mjs`:
24/24. Mutation-proven 3/3 on the new rule (reverting its regex failed exactly
the three new classification tests, none of the timeout tests). `npm run
build-verify` exit 0. `npm run build:renderer` exit 0, 377 files.

### Still open

- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all remain
  exactly as reported in Audit 30 — none touched this iteration.
- The log-reading habit above: worth a standing note rather than a one-off fix,
  since `test:js` runs 117 files in one log and will keep doing so.

## Audit 32 — a fourth call site for a module three others already used

### New species

None. This is the same defect `core/friendlyAlert.js` documents in its own
header comment ("Twelve places in the app answer a failure with a bare
alert() carrying raw exception text") — `projectManager.js` was simply never
converted when the other four files were.

### Why this file, this iteration

The standing instruction was to pick something smaller than `visionscope`'s
i18n gap, sized like Iteration 29 or 31. Before landing on this: confirmed the
`seekTo` bare-`'Seek failed'` item from Iteration 29/Audit 30's "still open"
list was already closed by Iteration 31 (stale carry-forward, not a live
gap); confirmed the 10 orphaned Preflight label keys are explicitly flagged in
Audit 30 as "not a decision to take at the tail of a loop run"; ran the full
`npm run test:js` looking for an already-red test as a shortcut to a live bug
— 0 failures, nothing surfaced that way. A grep for `alert(` across `src/`
narrowed to `window.alert(\`...: ${r?.error...}\`)` in `projectManager.js`,
which matches the bug shape `friendlyAlert.js`'s own header describes almost
verbatim, and the file itself had no uncommitted local changes.

### A repo-wide finding that reshaped what was touchable

Before editing anything, `git diff --stat` was checked file-by-file across
every path `git status` showed as modified, because a repo-wide
`100644→100755` mode-only diff (~699 files, unrelated to any of this work)
was already known to co-exist with a handful of genuinely dirty files. The
check found roughly **60 files with real, uncommitted content changes**
spanning nearly every major subsystem — auth, IMF, `trlconf`, `trailerConform`,
`prep_mark`, `render_queue.js`, the Electron IPC layer, the Python companion
engine, both stylesheets — not just the one or two files previously known to
be in flight. None of those files were read for editing purposes, staged, or
otherwise touched. `projectManager.js` was confirmed clean via the same
`git diff --stat` check before any edit began, and was the only file besides
this pair of docs and the one test file modified this iteration.

### Gate detail

The label-format assumption cost one retry: the first draft passed the
project name as an interpolated template-literal label —
`` friendlyAlert(err, `Deleting "${proj.name}" failed`) `` — which reads fine
but doesn't match `friendlyAlert.test.mjs`'s own label-shape regex, which only
recognises a plain single/double-quoted string as the second argument (a
template literal's backtick isn't in its character class). That test failure
is what surfaced the file's actual convention: every existing converted site
uses a *static* phrase as the label and lets `friendlyError()` see the
per-instance detail via the first (error) argument instead. Second pass moved
`proj.name` into the error argument (`` `${proj.name}: ${r?.error || 'unknown
error'}` ``) and used static labels ("Deleting project failed", etc.),
matching the other four files' pattern.

### Verification

`tests-js/friendlyAlert.test.mjs`: 9/9, `CONVERTED` table extended to 4 files /
10 labelled call sites. Mutation-proven 1/1: reverted the delete call site to
its original raw `window.alert` form, confirmed the call-count assertion
failed (9 seen where 10 were expected), restored the file, confirmed 9/9 green
again. `npm run build-verify` exit 0 — Node tests, `tests-js/*` (117 files, 0
failures), Python pytest (250 passed / 7 skipped), innerHTML/XML/fail-open
scan gates all clean. `npm run build:renderer` exit 0, 377 files.

### Still open

- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all remain
  exactly as reported in Audit 30 — none touched this iteration.
- The ~60-file scope of genuinely uncommitted, in-progress work discovered
  this iteration is not itself a defect, but it substantially narrows where a
  future iteration can safely work without disturbing it — worth surfacing to
  whoever owns that work rather than assuming it will resolve itself.
- `render_queue.js`'s private `_parseError` still returns `null` on a miss
  instead of delegating to `friendlyText` (open since Audit 1) — confirmed
  still true this iteration, and confirmed still blocked by the same
  unrelated pending edit in that file the original note described.

## Audit 33 — the coverage test's own blind spot, not a new call-site conversion

### New species

Yes, a first: every prior friendlyError/friendlyAlert iteration (28 through
32) fixed a *call site* that skipped translation. This one instead fixes the
*enforcement mechanism* — `tests-js/errorI18n.test.mjs` — which had a
structural blind spot for exactly the shape Iterations 29, 31, and 32
introduced. `translate()` is called directly on a literal in the four
`SCANNED` modules, so a regex over each file's own text finds it. But
`friendlyAlert(err, 'label')` calls `translate(label)` one level removed:
inside `friendlyAlert.js`, on an argument supplied by whichever file called
it. A regex scoped to `friendlyAlert.js`/`friendlyError.js` text alone can
never see a string that only exists in five other files' call sites. Four
iterations had already introduced 9 such labels — including this file's own
Iteration 32 conversion two entries above — with no test able to notice any
of them were English-only in six locales.

### Why this file, this iteration

Surveyed every remaining `alert()` call site in the codebase looking for a
fifth conversion candidate matching Iterations 29/31/32's pattern: none
remained in non-dirty files (checked `bwav/popup.js`, `bwav/app.js`,
`preflight/app/*.js` — already uses its own `failureAlert` helper — the two
ExtendScript files, which run in Adobe After Effects' own JS runtime and
cannot import a browser/Electron module, and `ocfViewer.js`'s debug JSON
dump). With that bug class exhausted, the next question was whether the
enforcement test itself had a gap, since `errorI18n.test.mjs`'s own header
explicitly names "any module that reaches for translate()" as the risk
surface — and `friendlyAlert.js` reaches for `translate()` too, just once
removed. Grepping every `friendlyAlert(` call site's second argument against
`ERROR_DICT` confirmed all 9 unique labels were missing from all six locales.

### A judgment call: reading dirty files without editing them

Two of the five caller files (`vfxPullPanel.js`, `reviews/index.js`) are among
the ~60 files already confirmed to carry genuine uncommitted changes (Audit
32). The new test needs their text only to extract string literals via
regex — the same thing `errorI18n.test.mjs` already does to `saveNotice.js`,
`printOutcome.js`, `proResProxy.js`, and `playableMedia.js`, none of which are
imported, only read as text. Reading a file's current on-disk content for a
regex scan is not an edit and does not touch, stage, or depend on whatever
uncommitted work is in progress there; only `i18n.js` and
`errorI18n.test.mjs` — both clean before this iteration — were modified.

### Gate detail

One count needed a second look: `reviews/index.js` has 5 `friendlyAlert(`
calls, but one — `friendlyAlert(notice.text, label)` — passes a variable,
not a literal, so the label-extraction regex (which requires a quoted
string as the second argument) correctly does not match it. That call
re-displays a status-strip notice through whatever label it was already
raised with, so it has nothing new to translate — `ERROR_DICT` already
covers whatever produced that label elsewhere. The other 4 calls are 3
distinct literals ("Reviews JSON/CSV/PDF export failed", with PDF appearing
twice), so the file's expected count is 3, not 4 — the first draft assumed
one entry per call site, corrected after the test named the mismatch.

### Verification

`node --test tests-js/errorI18n.test.mjs`: 29/29 green, including 5 new
`SCANNED_LABELS` tests. Mutation-proven 2/2: deleting the ko row for "EXR
export failed" failed `ko: every failure message is translated` (and its
`key parity` knock-on), restored, green again; bumping
`smart_engine_settings.js`'s expected label count from 1 to 2 failed with
`1 !== 2` naming the exact file, restored, green again. Full
`npm run build-verify` exit 0 (Node tests, `test:js`, `test:py` — 250 passed /
7 skipped, innerHTML/XML/fail-open scan gates all clean). `npm run
build:renderer` exit 0, 377 files.

### Still open

- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all remain
  exactly as reported in Audit 30 — none touched this iteration.
- The ~60-file scope of genuinely uncommitted, in-progress work first
  surfaced in Audit 32 is unchanged this iteration; still worth surfacing to
  whoever owns it.
- `render_queue.js`'s private `_parseError` still returns `null` on a miss
  instead of delegating to `friendlyText` (open since Audit 1) — unchanged.
- Worth a forward note: any *future* file that reaches for `translate()`
  through a still-different shape (not a direct literal call, not a
  friendlyAlert label) would reproduce this same blind spot a third way.
  `errorI18n.test.mjs`'s two scanners (`SCANNED`, `SCANNED_LABELS`) are each
  narrow by design — that is what makes their assertions meaningful — but it
  means each new indirection pattern needs its own scanner, not a widening of
  an existing regex.

## Audit 34 — a file's own header comment named the contract it hadn't finished implementing

### New species

Every prior i18n iteration in this run found a call site that never reached
for `translate()` at all, or a `friendlyAlert` label the scanner had never
been taught to see. This one is different in kind: `smart_engine_settings.js`
already imported `friendlyStatus`, already documented (lines 19-24) exactly
how the label/tail split was supposed to work, and one of its 7 call sites
(the "Engine check failed" line) already followed that documented pattern —
apparently added, mid-iteration, in a prior pass that never finished the
other 6. Grepping every `friendlyStatus(\`<Label>: ...\`)` call site in the
file against its own header comment's contract, and against
`visualQcModal/index.js`'s already-correct usage of the same pattern,
confirmed 6 of 7 sites were still handing the label straight through in
English. This is a documentation/implementation gap inside a single file,
not a missing scanner — the closest analogue in this run is Audit 30, where
a rule existed but a call site was never wired to it.

### Why this file, this iteration

A background Explore agent was dispatched with an explicit exclusion list
(visionscope i18n, the 10 orphaned Preflight keys, the 829-string native
pass, `render_queue.js`'s `_parseError`, and the friendlyAlert-conversion/
label-translation bug classes already fixed in Iterations 31-33) and an
explicit git-cleanliness requirement, to avoid re-finding an already-closed
defect or touching one of the ~60 files with genuine in-progress work. Its
report was independently re-verified end to end before any edit: git-clean
status via `git status`/`git diff --stat`, the exact 7 call sites and line
numbers via grep, the documented `friendlyStatus` contract via a direct read
of `friendlyError.js` lines 317-352, the established fix pattern via a read
of `visualQcModal/index.js`, and the coverage gap in
`tests-js/smartEngineSettings.test.mjs` (its prefix-format test checks the
label has a space and matches `/fail/i`, never translation). Per this run's
standing policy, a background agent's report is not user input and is not
actionable until independently verified — it was, here, on every factual
claim before implementation began.

### Gate detail

The existing `smartEngineSettings.test.mjs` regex that extracts a
`friendlyStatus` call's contents, `` /friendlyStatus\(`([^`]*)`\)/g ``,
captures everything between the backticks — so embedding `${translate(...)}`
inside the label position still matches correctly, and that test needed no
edit, only re-running to confirm. The new translated strings were added to
`errorI18n.test.mjs`'s `SCANNED` array (the direct-`translate('...')`-literal
scanner already covering `saveNotice.js`, `printOutcome.js`,
`proResProxy.js`, and `playableMedia.js`) rather than `SCANNED_LABELS` (the
`friendlyAlert`-second-argument scanner), since these are now direct
`translate('...')` calls, not `friendlyAlert(err, 'label')` calls — the two
scanners exist for genuinely different call shapes and this file happens to
use both (it also has one pre-existing `friendlyAlert` label already covered
by `SCANNED_LABELS` from Iteration 33).

### Verification

`node --test tests-js/errorI18n.test.mjs`: 30/30 green, including 1 new
`SCANNED` test. `node --test tests-js/smartEngineSettings.test.mjs`: 13/13
green, unmodified. Mutation-proven 2/2: deleting the ko row for "Engine check
failed" failed `ko: every failure message is translated` (and its key-parity
knock-on), restored, green again; bumping `smart_engine_settings.js`'s
`SCANNED` expected count from 5 to 4 failed with `4 !== 5` naming the exact
file, restored, green again. Full `npm run build-verify` exit 0 (Node tests,
`test:js`, `test:py` — 250 passed / 7 skipped, innerHTML/XML/fail-open scan
gates all clean). `npm run build:renderer` exit 0, 377 files.

### Still open

- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all remain
  exactly as reported in Audit 30 — none touched this iteration.
- The ~60-file scope of genuinely uncommitted, in-progress work first
  surfaced in Audit 32 is unchanged this iteration.
- `render_queue.js`'s private `_parseError` still returns `null` on a miss
  instead of delegating to `friendlyText` (open since Audit 1) — unchanged.
- The forward note from Audit 33 stands: any future file reaching for
  `translate()` through a still-different call shape will reproduce this same
  blind spot a third way, and will need its own scanner rather than a widened
  regex on `SCANNED` or `SCANNED_LABELS`.

## Audit 35 — a species change: a lifecycle bug, not another i18n gap

### New species

Every fix from Iteration/Audit 29 through 34 was some variant of the same
species — a string reaching the user without going through `translate()` or
`friendlyStatus()`'s documented contract. This iteration breaks that streak.
`electron/companion.js`'s `CompanionBridge.start()` spawns a Python
subprocess and probes it for readiness, retrying once after a 3-second
delay. The `catch` block for a *second* consecutive probe failure logged the
error and emitted `'unavailable'`, but never killed the still-running
subprocess and never cleared `this._proc`. Because `start()` opens with
`if (this._proc) return;`, that omission has two compounding effects: the
Python process is orphaned (no reference left to reap or message it), and
`start()` becomes permanently inert for the rest of the app's lifetime — the
only call site, `electron/main.js:292`, would silently no-op on every future
attempt. This is a resource-lifecycle bug, not a translation gap.

### Why this file, this iteration

A background Explore agent was dispatched with an explicit exclusion list
covering every previously-fixed i18n bug class (Iterations 29-34) plus every
previously-identified-and-deferred item (visionscope i18n, the 10 orphaned
Preflight keys, the 829-string native pass, `render_queue.js`'s
`_parseError`, and the ~60 files carrying genuine uncommitted in-progress
work), and an explicit git-cleanliness requirement. It proposed this bug.
Before acting, every claim was independently re-verified: `git status
--short`/`git diff --stat` on `electron/companion.js` confirmed a mode-only,
genuinely clean file; a direct read of lines 1-110 confirmed the exact code
and line numbers matched the report; a grep across `electron/` and `src/`
confirmed `main.js:292` is the sole caller of `companion.start()`; and a
search for existing test coverage confirmed `tests-js/companionAuth.test.mjs`
— despite the name — tests an unrelated module
(`src/scripts/modules/companionAuth.js`'s URL-token helpers), leaving
`CompanionBridge`'s lifecycle genuinely untested. Per this run's standing
"trust but verify" policy, a background agent's report is not itself
actionable — it was independently confirmed on every factual point before any
edit was made.

### The fix

Added `if (this._proc) { this._proc.kill('SIGTERM'); this._proc = null; }`
to the `catch (retryErr)` block, immediately before the existing
`this.emit('unavailable', retryErr.message);` call. Deliberately did not add
a redundant `this._ready = false;` in that branch — `_ready` starts `false`
in the constructor and is never set `true` on this path, so an assignment
there would be a no-op restating an existing invariant rather than fixing
anything.

### Test approach

`electron/companion.js` is CommonJS and destructures
`const { spawn } = require('child_process');` at module load time, and the
whole module is exported as a pre-built singleton
(`module.exports = new CompanionBridge();`), not the class itself. With no
mocking library in this project's devDependencies, the new
`tests-js/companionStartupRetry.test.mjs` exploits `require`'s module cache
directly: it requires `child_process` first, overwrites its `spawn`
property with a fake that returns an `EventEmitter`-based stand-in process,
and only then requires `electron/companion.js` — whose own
`require('child_process')` returns the same cached, now-patched module
object, so its destructured `spawn` binds to the fake with no interception
framework needed. The test also stubs the singleton's `_waitReady()` to
always reject (isolating the bug under test from the unrelated
length-prefixed-protocol and readiness-probe machinery) and temporarily
overrides the global `setTimeout` to fire immediately, collapsing the real
3-second inter-retry delay so the test runs in milliseconds. It asserts the
fake subprocess was `kill()`ed, `this._proc` is `null`, `isReady` is
`false`, and that a subsequent `start()` call actually respawns rather than
being blocked by the `if (this._proc) return;` guard.

### Verification

`node tests-js/companionStartupRetry.test.mjs`: 1/1 green. Mutation-proven:
reverted the fix to the original log-and-emit-only body, reran — failed
exactly as expected on
`the orphaned subprocess must be killed once both probe attempts fail`
(`false !== true`), restored, green again. Full `npm run build-verify` exit
0, including `tests-js/selfContained.test.mjs`'s "no new test file is left
out of git" gate, which failed on the first gate run because the new test
file was still untracked (`git add`ed and re-run to confirm clean).
`npm run build:renderer` was not run: `electron/companion.js` is
Electron main-process code under `electron/`, not `src/`-facing renderer
code, so per the project's one-source-two-targets convention this fix needs
no renderer rebuild.

### Still open

- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all
  remain exactly as reported in Audit 30 — none touched this iteration.
- The ~60-file scope of genuinely uncommitted, in-progress work first
  surfaced in Audit 32 is unchanged this iteration.
- `render_queue.js`'s private `_parseError` still returns `null` on a miss
  instead of delegating to `friendlyText` (open since Audit 1) — unchanged.
- `CompanionBridge` still has other lifecycle paths without dedicated
  coverage — the first-attempt success path, `stop()`, and `_onData`'s
  frame-desync recovery (the `MAX_COMPANION_MSG_BYTES` resync branch) among
  them — any of which could be a future iteration's target.

## Iteration 36 — TOCTOU race in the cross-tab queue lease

### New species

Every fix so far this run has been either an i18n gap or an
Electron-main-process lifecycle bug. This is the first concurrency bug:
a check-then-act race split across two IndexedDB transactions with an
`await` boundary in between, in code whose entire purpose is to prevent
exactly the kind of "two actors both think they're in charge"
inconsistency it was itself vulnerable to.

### Why this file, this iteration

`src/scripts/core/crossTabQueueLease.js` elects a single leader tab (via
IndexedDB + BroadcastChannel + heartbeat) so that only one open tab of the
app ever calls `renderWorkerClient.buildProxy()` and submits jobs. Reading
`acquireLease()`/`releaseLease()` showed both delegated to `_getLease()`
(a `readonly` transaction) then, after an `await`, `_setLease()` (a
separate `readwrite` transaction) — or in-lined the equivalent
get-then-`await`-then-put shape directly. IndexedDB's serialization
guarantee only applies to transactions, not to the JavaScript sandwiched
between two of them, so two tabs whose `setTimeout(() => acquireLease(),
100)` on-load timers fire close together (the ordinary case, not an edge
case) could both complete their `get` before either commits a `put`, both
see no existing/valid lease, and both write themselves in as leader.
There is no existing test coverage for this file at all prior to this
iteration.

### The fix

Rewrote `acquireLease()` and `releaseLease()` to perform their get and
put inside a single `readwrite` transaction each, rather than going
through the two-transaction `_getLease()`/`_setLease()` helpers. Real
IndexedDB serializes `readwrite` transactions against the same object
store, so once this transaction's `get` runs, no other transaction can
run its own `get` or `put` against the same key until this transaction's
`put` (if any) has committed — the decision and the write are now
atomic with respect to other tabs. `_getLease()`/`_setLease()` themselves
are untouched and remain in use by `checkLeadership()` (read-only, so no
race exists there) and by the heartbeat interval (still two transactions,
deliberately left as-is — see Still open).

### Test approach

This is the first test in the suite to sandbox-execute a plain
global-scope IIFE (not a CommonJS or ES module) via `node:vm`.
`tests-js/crossTabQueueLeaseRace.test.mjs` reads
`crossTabQueueLease.js`'s source as text, builds a `vm.createContext()`
per simulated tab with `ctx.window = ctx; ctx.globalThis = ctx;` (mirroring
the browser's `window === globalThis` self-reference the source code
relies on for `window.PFX_QUEUE_LEASE = {...}`), and runs the source into
each context so the two tabs get independent module state
(`_isLeader`, `_heartbeatTimer`, etc.) while sharing one fake IndexedDB
instance — the actual point of contention. The fake IndexedDB is
hand-rolled (no `fake-indexeddb` dependency in this project) with just
enough of `open()`/`transaction()`/`objectStore().get()/.put()` to run
the lease code, and — critically — serializes `readwrite` transactions
on the same store via a promise-chained write lock, which is what allows
it to faithfully reproduce IndexedDB's real ordering guarantee closely
enough to both expose the pre-fix race and confirm the post-fix
atomicity. One non-obvious bug surfaced while building the fake: its
op-queue was originally drained with `ops.forEach(op => op())`, but
`acquireLease()`'s `get()` handler synchronously calls `put()` (queuing a
new op) from inside the `get()`'s own `onsuccess` callback — and
`Array.prototype.forEach` captures the array's `length` once at call time,
so it silently skipped that late-appended `put`. Replaced with a drain
loop (`while (ops.length) ops.shift()();`) that keeps consuming ops
appended during its own iteration.

### Verification

`node --test tests-js/crossTabQueueLeaseRace.test.mjs`: 1/1 green.
Mutation-proven: reverted `acquireLease()`/`releaseLease()` back to the
two-transaction `_getLease()`+`_setLease()` shape, reran — failed with
both racing tabs reporting `isLeader() === true` (violating "exactly one
racing tab must win leadership"), confirming the test genuinely detects
the race rather than passing vacuously; restored, green again. Full
`npm run build-verify` exit 0 (log: `/tmp/gate36.log`) — Node test-runner
suite, `tests-js/*.test.mjs`, Python companion pytest (250 passed, 7
skipped), and the innerHTML/rawXML/fail-open scan gates all clean,
including `tests-js/selfContained.test.mjs`'s "no new test file is left
out of git" check once the new file was `git add`ed. `npm run
build:renderer` was run (confirmed via `dist/desktop/scripts/core/
crossTabQueueLease.js` containing the fixed `acquireLease` body and
having a newer mtime than the `src/` original) since this changes
`src/`-facing renderer code shipped into both `dist/desktop/` and
`dist/extension/`.

### Still open

- The heartbeat interval (`_startHeartbeat()`'s callback) still reads via
  `_getLease()` and writes via `_setLease()` as two separate
  transactions — the same race shape, but far lower severity: a lost
  race there just means one tab's heartbeat refresh is superseded by
  another tab's takeover attempt, not two tabs simultaneously believing
  they're leader. Left for a future iteration if it proves to matter in
  practice.
- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all
  remain exactly as reported in Audit 30 — none touched this iteration.
- The ~60-file scope of genuinely uncommitted, in-progress work first
  surfaced in Audit 32 is unchanged this iteration.
- `render_queue.js`'s private `_parseError` still returns `null` on a miss
  instead of delegating to `friendlyText` (open since Audit 1) — unchanged.
- `CompanionBridge`'s untested lifecycle paths from Audit 35 (first-attempt
  success, `stop()`, `_onData`'s frame-desync recovery) remain untouched.

## Iteration 37 — unhandled async EPIPE on companion stdin crashed the whole app

### New species

The first bug this run in the "unhandled async stream/event error" class —
distinct from Iteration 35's synchronous-path lifecycle bug and Iteration
36's IndexedDB transaction race, though all three live in
`CompanionBridge`'s neighborhood of subprocess-management code.

### Why this file, this iteration

A background Explore agent was asked to find a genuine, unfixed,
well-scoped bug in `electron/`, `src/scripts/`, or `companion/`, explicitly
excluding every already-fixed or already-deferred item from Iterations
30, 35, and 36. It surfaced this as its top candidate: `start()` attaches
listeners for `stdout`'s `'data'`, `stderr`'s `'data'`, and the
subprocess's own `'error'`/`'exit'` events, but nothing for
`this._proc.stdin`. `_sendRaw()`'s `try/catch` around its two
`stdin.write()` calls only catches synchronous throws. Node surfaces a
post-death pipe write failure (EPIPE) as an *asynchronous* `'error'`
event on the stream instead, and an `EventEmitter` with no `'error'`
listener throws by default when one fires — uncaught here, which crashes
the entire Electron main process (every window, not just the one failed
call) over what amounts to a routine "the companion died mid-flight"
condition. Verified independently before acting: read `start()` and
`_sendRaw()` directly to confirm no `stdin` listener exists anywhere in
the file, and confirmed `tests-js/companionStartupRetry.test.mjs`'s fake
process gives `stdin` as `{ write: () => {} }` — a plain object that
structurally cannot have exercised this path, since it has no event
machinery at all.

### The fix

Added `this._proc.stdin.on('error', (err) => console.warn(...))`
immediately after the other post-spawn listeners in `start()`. This
downgrades a would-be process crash to a logged warning — exactly the
outcome the existing `_sendRaw()` try/catch was presumably intended to
achieve for the synchronous case, now extended to the async one Node
actually uses for this failure mode.

### Test approach

`tests-js/companionStdinError.test.mjs` follows the same require-cache
patching pattern as `companionStartupRetry.test.mjs` (swap
`child_process.spawn` before requiring the `companion.js` singleton), but
gives the fake process a real `EventEmitter` for `stdin` instead of a
plain object. After a successful mocked `start()`, the test calls
`spawnedProcs[0].stdin.emit('error', new Error('EPIPE...'))` directly —
this is the same code path Node itself would take internally when a real
pipe write fails post-death, so exercising it needs no real subprocess,
no actual broken pipe, and no IPC framework: a bare `EventEmitter`
faithfully reproduces the exact hazard (emit-with-no-listener throws) that
makes this bug dangerous. This also meant fixing
`companionStartupRetry.test.mjs`'s fake `stdin` — a plain
`{ write: () => {} }` object broke as soon as `companion.js` called
`.on()` on it — by giving it a real `EventEmitter` with a `write` method,
which is a strictly more accurate fake of Node's actual stream shape and
costs nothing else in that test.

### Verification

`node --test tests-js/companionStdinError.test.mjs
tests-js/companionStartupRetry.test.mjs`: 2/2 green. Mutation-proven:
removed the new `stdin.on('error', ...)` listener, reran — the emitted
`EPIPE` error itself propagated out of the test as an uncaught exception,
failing it exactly as expected; restored, green again. Full `npm run
build-verify` exit 0 (log: `/tmp/gate37.log`) — this run also caught the
`companionStartupRetry.test.mjs` fake-stdin breakage described above on
the first pass (`TypeError: this._proc.stdin.on is not a function`),
which was fixed before the gate was considered clean. `npm run
build:renderer` was not run: `electron/companion.js` is Electron
main-process code, not `src/`-facing renderer code.

### Still open

- `CompanionBridge`'s other untested lifecycle paths from Audit 35
  (first-attempt startup success, `stop()`, `_onData`'s
  `MAX_COMPANION_MSG_BYTES` frame-desync recovery) remain untouched.
- The heartbeat-interval lease race identified in Audit 36 is unchanged.
- The 10 orphaned label keys, the 829 machine-authored strings wanting a
  native-speaker pass, and `src/tools/visionscope/*`'s missing i18n all
  remain exactly as reported in Audit 30 — none touched this iteration.
- The ~60-file scope of genuinely uncommitted, in-progress work first
  surfaced in Audit 32 is unchanged this iteration.
- `render_queue.js`'s private `_parseError` still returns `null` on a miss
  instead of delegating to `friendlyText` (open since Audit 1) — unchanged.

## Iteration 38 — storage.js's get() failed to mirror chrome.storage.local's missing-key semantics

### New species

A data-shape/API-parity bug — the first of that flavor this cycle. Distinct
from the async-error and race-condition species of Iterations 35-37:
nothing here is timing-dependent or subprocess-related, it's a shim that
silently disagrees with the real API it claims to replace.

### Why this file, this iteration

A background Explore agent scouted `electron/`, `src/scripts/`, and
`companion/` for a fresh, well-scoped, unfixed bug outside everything
already closed or deferred in Iterations 30 and 35-37. It flagged
`electron/storage.js`: its own header comment says "File-based key-value
store replacing chrome.storage.local... API mirrors chrome.storage.local,"
but `get()` diverges from the documented real-API contract. Real
`chrome.storage.local.get()` omits any key that was never set from its
result object. `storage.js`'s single-string-key branch,
`return { [keys]: _cache[keys] }`, and its array branch,
`for (const k of keys) result[k] = _cache[k]`, both unconditionally
assign into the result regardless of whether the key exists in `_cache`,
producing `{ key: undefined }` entries for absent keys instead of omitting
them. Verified by reading `get()` directly and confirming `electron/
ipc.js`'s `pfx:storage:get` handler forwards to it with zero
transformation, so the renderer-facing IPC surface inherits the same
divergence. `'key' in result` and `Object.keys(result).length` are the
idiomatic chrome.storage.local presence checks; both give a wrong answer
against this shim's original behavior.

### The fix

Both branches now only assign into the result object when the key is
actually present in `_cache`, checked via `k in _cache`:

```js
if (typeof keys === 'string') {
  return (keys in _cache) ? { [keys]: _cache[keys] } : {};
}
const result = {};
for (const k of keys) {
  if (k in _cache) result[k] = _cache[k];
}
return result;
```

`get(null)` (get-all via `{ ..._cache }`) was already correct and untouched.

### Test approach

New `tests-js/storageGetOmitsMissingKeys.test.mjs`. `storage.js` does
`const { app } = require('electron');` and calls `app.getPath('userData')`
on first use; outside a real Electron process, `require('electron')`
resolves to a plain path string (the Electron binary path), not an object,
so destructuring `app` from it would be `undefined`. The test injects a
fake module into Node's own require cache at the resolved `electron`
module id — `require.cache[require.resolve('electron')] = { ...,
exports: { app: { getPath: () => tmpDir } } }` — before requiring
`storage.js`, the same require-cache-patching technique the companion
tests use for `child_process.spawn`, just applied to a different module
id. Four cases: a missing single key returns `{}`; a missing key inside a
multi-key array request is dropped while a present key in the same
request survives; a present single key still returns correctly; `get(null)`
is unaffected.

### Verification

`node --test tests-js/storageGetOmitsMissingKeys.test.mjs`: 4/4 green.
Mutation-proven: reverted both branches to their original unconditional
assignment, reran — two assertions failed with the literal `{ missing:
undefined }` / `{ foo: 'bar', missing: undefined }` shapes in the actual
output, confirming the test genuinely detects the regression; restored,
green again. Full `npm run build-verify` — first pass failed at
`tests-js/selfContained.test.mjs`'s "no new test file is left out of git"
gate because the new test file hadn't been `git add`ed yet; staged it and
reran clean, exit 0 (log: `/tmp/gate38b.log`; Python suite 250 passed, 7
skipped). `npm run build:renderer` was not run — `electron/storage.js` is
Electron main-process code, not `src/`-facing renderer code.

### Still open

- `remove()` and `set()`'s behavior against non-existent keys were not
  compared to the real chrome.storage.local contract in this pass — only
  `get()` was audited for parity gaps.
- The `folder_picker.py` AppleScript-injection surface surfaced during this
  iteration's scouting is unverified and out of scope: every current call
  site passes a hardcoded dialog title, so no exploitable path is
  currently known — flagged as a possible future target, not a confirmed
  bug.
- `CompanionBridge`'s other untested lifecycle paths (Audit 35), the
  heartbeat-interval lease race (Audit 36), the i18n gaps and
  `src/tools/visionscope/*` (Audit 30), the ~60-file uncommitted-work scope
  (Audit 32), and `render_queue.js`'s `_parseError` (Audit 1) all remain
  unchanged.

## Iteration 39 — storage.js's get() threw on the chrome.storage defaults-object call form

### New species

A follow-on to Iteration 38's API-parity species, but a sharper variant:
not a wrong-shape result, an outright thrown exception on a call form the
real API supports — and one masked into a silent data-loss bug by an
unrelated `.catch` upstream, making it harder to notice than a crash
would normally be.

### Why this file, this iteration

Having just fixed one chrome.storage.local parity gap in `get()` in
Iteration 38, a background Explore agent was sent back to the same file
to check whether other parts of the real API's contract were still
unhandled, rather than assuming the fix was complete. It found that
`get()` only ever handled two of chrome.storage.local's three documented
call forms — string/array of keys, and `null`/omitted for get-all — and
never handled the third: a plain defaults object,
`chrome.storage.local.get({ key: defaultValue, ... })`, where Chrome
returns the stored value if the key exists, or the caller's own default
if it doesn't. `storage.js`'s `for (const k of keys)` loop throws
`TypeError: keys is not iterable` the moment `keys` is a plain object
rather than an array, since plain objects aren't iterable.

This is directly reachable, not theoretical: `src/tools/bwav/
background.js:76,84` calls `chrome.storage.local.get({ pendingLogs: [] })`,
`src/tools/bwav/options.js:18` calls it with a multi-key defaults object,
and `src/tools/bwav/app.js:793` calls
`chrome.storage.local.get({ groupLabelsOverride: null })` — all three
files ship into the desktop app via `build-renderer.js`'s copy step. The
practical severity is worse than a visible crash: `electron/preload.js`'s
`chrome.storage.local.get` shim wraps the `ipcRenderer.invoke()` call in
`.catch(() => ({}))`, so the `TypeError` thrown inside the
`pfx:storage:get` IPC main-process handler never surfaces to the caller —
it's swallowed into an empty object. Callers relying on their own
defaults (e.g. `options.js`'s settings load, `app.js`'s override lookup)
silently get `undefined` for every field instead of the configured
default, with no error anywhere in the chain to point at the cause.

### The fix

Added a third branch to `get()`, checked after the string and array
cases, for the plain-object defaults form:

```js
if (Array.isArray(keys)) {
  const result = {};
  for (const k of keys) {
    if (k in _cache) result[k] = _cache[k];
  }
  return result;
}
// Defaults-object form: chrome.storage.local.get({ key: defaultValue })
// returns the stored value if present, else the caller-supplied default.
const result = {};
for (const k of Object.keys(keys)) {
  result[k] = (k in _cache) ? _cache[k] : keys[k];
}
return result;
```

The array branch was pulled out from the tail of the function into its
own explicit `Array.isArray(keys)` check so the final fallthrough branch
is unambiguously the defaults-object case, rather than relying on
"whatever's left after string and null" to also mean array.

### Test approach

Extended the existing `tests-js/storageGetOmitsMissingKeys.test.mjs` from
Iteration 38 — same file, same require-cache-patched `electron` module,
no new scaffolding needed. New case: seed the cache with `{ foo: 'bar' }`,
call `get({ foo: 'fallback', missing: 'default' })`, assert the result is
`{ foo: 'bar', missing: 'default' }` — the present key keeps its stored
value, the absent key falls back to the caller's default.

### Verification

`node --test tests-js/storageGetOmitsMissingKeys.test.mjs`: 5/5 green.
Mutation-proven: reverted `get()` to the two-branch (string/array-only)
version, reran — the new test failed with the literal `TypeError: keys is
not iterable` reproduction, confirming the test genuinely exercises the
bug; restored, green again. Full `npm run build-verify` exit 0 on the
first pass this time (log: `/tmp/gate39.log`; Python suite 250 passed, 7
skipped) — no new test file was created (only the existing one extended),
so the `selfContained.test.mjs` untracked-file gate that caused a
first-pass failure in Iterations 36 and 38 didn't apply here.
`npm run build:renderer` was not run — `electron/storage.js` is Electron
main-process code, not `src/`-facing renderer code.

### Still open

- The Iteration 38 deferred item questioning `remove()`/`set()`'s
  non-existent-key handling was re-checked this iteration and found to
  already match chrome.storage.local's contract correctly — closing that
  item as verified-fine rather than carrying it forward as an open gap.
- The `folder_picker.py` AppleScript-injection surface remains unverified
  and out of scope: every current call site still passes a hardcoded
  dialog title.
- `CompanionBridge`'s other untested lifecycle paths (Audit 35), the
  heartbeat-interval lease race (Audit 36), the i18n gaps and
  `src/tools/visionscope/*` (Audit 30), the ~60-file uncommitted-work scope
  (Audit 32), and `render_queue.js`'s `_parseError` (Audit 1) all remain
  unchanged.

## Iteration 40 — pfx:download silently dropped conflictAction, always overwriting on silent writes

### New species

Every prior iteration in this file has been a self-contained logic bug
in one file. This one is the first to surface a **cross-file argument-
threading gap**: the bug isn't in either file's own logic in isolation,
but in the fact that a parameter accepted by the shim (`preload.js`) was
never passed across the IPC boundary to the handler (`ipc.js`) that
needed it — and even if it had been, the handler's own logic didn't
honor it either. It's also the first iteration where the investigation
itself — not the code fix — consumed most of the effort, because of an
unrelated discovery described below.

### Why this file, this iteration

`electron/preload.js`'s `chrome.downloads.download` shim exists to give
`src/`-shared renderer code a drop-in replacement for the real Chrome
extension API. `render_queue.js` and `visualQcModal/index.js` call it
with no explicit `conflictAction` (relying on Chrome's documented
`'uniquify'` default), while `projectFile.js` calls it with
`conflictAction: 'overwrite'` for explicit save-over-existing semantics.
Tracing the shim's `invoke('pfx:download', { url, filename, saveAs })`
call showed `conflictAction` was never included in the payload — dropped
at the shim, not even reaching `ipc.js`. Tracing further into `ipc.js`'s
`pfx:download` handler showed that even a forwarded `conflictAction`
would have been ignored: the silent-write (`saveAs === false`,
`dataUrl`-based) branch called `fs.writeFileSync(defaultPath, ...)`
unconditionally. The practical effect: a caller requesting the (default)
uniquify behavior to avoid clobbering a previous export instead silently
overwrote it, with no error, no warning, and no way to detect that data
was lost.

### The fix

`electron/preload.js` — forward the new parameter through the shim:

```js
const downloads = {
  download({ url, filename, saveAs, conflictAction }, callback) {
    invoke('pfx:download', { url, filename, saveAs, conflictAction })
```

`electron/ipc.js` — add a uniquify helper and use it unless the caller
explicitly opts into overwrite:

```js
function _uniquifyPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
// ...
if (dataUrl) {
  const finalPath = conflictAction === 'overwrite' ? defaultPath : _uniquifyPath(defaultPath);
  const [, b64] = dataUrl.split(',');
  fs.writeFileSync(finalPath, Buffer.from(b64, 'base64'));
  return { ok: true, filePath: finalPath };
}
```

Scoped deliberately to the `dataUrl` silent-write branch only — the
`webContents.downloadURL(url)` branch (used when the caller streams a
remote/blob URL instead of a data URL) has no equivalent pre-write
collision hook available without wiring up
`session.on('will-download')`, which nothing in the codebase does today;
left unchanged as genuinely out of scope rather than papered over.

### Test approach

New `tests-js/downloadConflictAction.test.mjs`, reusing the established
fake-`electron`-in-require-cache pattern from
`storageGetOmitsMissingKeys.test.mjs` / `companionStartupRetry`, since
`electron/ipc.js` does `require('electron')` at module load time.
Two cases against a real temp `Downloads` directory: writing `note.txt`
twice with default `conflictAction` yields `note.txt` then
`note (1).txt`, with both files' distinct contents surviving untouched;
writing `report.txt` twice with `conflictAction: 'overwrite'` reuses the
same path, and the second write's content wins.

### Verification

`node --test tests-js/downloadConflictAction.test.mjs`: both cases green.
Full `npm run build-verify` exit 0 against the true, full current
working-tree state (log: `/tmp/gate40c.log`; Python suite 250 passed, 7
skipped; XSS/XXE/fail-open gates all clean). `npm run build:renderer` was
not run — both changed files are Electron main-process code, not
`src/`-facing renderer code.

The bulk of this iteration's effort was not the fix but isolating it:
mid-iteration, inspecting the staged diff (`git diff --cached --stat`)
revealed implausibly large change sizes for both files
(`electron/ipc.js` ~560 lines, `electron/preload.js` ~30 lines) versus
the actual few-line fix. Investigation showed both files already carried
substantial, real, in-progress work predating this iteration entirely: a
Meechum/Edward enterprise OAuth + Netflix Team Workspaces authentication
flow (`_runMeechumSystemBrowserOAuth`, a loopback-HTTP-server PKCE flow
on ports 8477-8479), a `safeStorage`-encrypted PFX session-persistence
IPC API, an `_activeWindow`/`_ipcRegistered` window-reactivation guard
refactor (renaming `mainWindow` references), and new OCF proxy media
calls. This WIP is not inert — a `git stash push --keep-index` isolation
test showed an *existing* test already asserts `/pfx:meechum-oauth/` is
registered, meaning the WIP is integrated and depended upon elsewhere,
not dead code to discard. Rather than commit that WIP alongside this
iteration's unrelated fix (or destructively touch it in any way), the
scoped fix was reconstructed off disk as "HEAD content + only the
`conflictAction` edit" via Python string-replace with uniqueness
assertions, then staged directly into the git index with
`git hash-object -w <file>` + `git update-index --cacheinfo` — bypassing
`git add`'s all-or-nothing whole-file staging. The working tree itself
was never altered; it retains the full WIP + fix exactly as before. The
final `build-verify` gate run was against that true combined state
(not an artificially isolated one), since the WIP's own tests require it
present to pass.

### Still open

- The `webContents.downloadURL(url)` collision path remains unable to
  honor `conflictAction` at all, pending a future `will-download`
  session-hook wiring — genuinely out of scope, not deferred laziness.
- The large in-progress WIP surfaced this iteration in
  `electron/preload.js`/`electron/ipc.js` (Meechum/Edward OAuth flow, PFX
  session sync, `_activeWindow` guard, OCF proxy) is confirmed real and
  test-dependent; it remains untouched, unstaged, and out of scope for
  this audit loop, same as the broader ~576-file mode-bit/~60-file
  content-change anomaly from Audit 32.
- `CompanionBridge`'s other untested lifecycle paths (Audit 35), the
  heartbeat-interval lease race (Audit 36), the i18n gaps and
  `src/tools/visionscope/*` (Audit 30), and `render_queue.js`'s
  `_parseError` (Audit 1) all remain unchanged.

## Iteration 41 — otio.js's getTimeWarpInfo() latched `reversed`, mis-signing stacked double-negative retimes

### New species

The first bug in this loop found in the parser layer rather than
Electron main-process or renderer glue code — a sign/state-accumulation
bug in a loop that folds multiple effects into one summary flag, where
the accumulator ("has any negative scalar been seen") was conflated with
the value actually needed ("is the net effect, after all scalars, still
negative"). It's also the first iteration sourced from a background
scouting agent surveying `electron/main.js`, `electron/companion.js`,
the OTIO/EDL/FCPXML parsers, and native bridges specifically to steer
clear of the areas iterations 1-40 already covered or that are currently
off-limits (`src/tools/visionscope/*`, and `electron/preload.js`/
`electron/ipc.js` while their in-progress Meechum/Edward OAuth WIP
remains uncommitted).

### Why this file, this iteration

`getTimeWarpInfo()` (`src/scripts/parsers/otio.js:341`) exists to
collapse an OTIO clip's list of `LinearTimeWarp`/`FreezeFrame` effects
into one `{ scalar, speedPct, reversed, freeze }` summary, which
`buildClipEvent` and the stack-level equivalent both use to compute the
exported `speedFactor` on each event. The loop multiplies `Math.abs(ts)`
into `scalar` for every `LinearTimeWarp`, correctly accumulating
magnitude across multiple stacked effects — but for direction, it did
`if (ts < 0) reversed = true`, which only ever turns `reversed` on and
never back off. Two negative scalars in the same effects list (a
double-reverse — net forward motion, since reversing a reversed clip
plays it forward again) still leaves `reversed` stuck `true`. The
existing `resolve_retime.otio` fixture/test only exercised a *single*
`LinearTimeWarp` per clip (one 2x, one reverse), so this never showed up
until a clip with two stacked negative effects was constructed.

### The fix

```js
if (sch.startsWith("LinearTimeWarp")) {
  const ts = Number(e?.time_scalar);
  if (Number.isFinite(ts) && ts !== 0) {
    if (ts < 0) reversed = !reversed;
    scalar *= Math.abs(ts);
  }
}
```

Changing `reversed = true` to `reversed = !reversed` makes the flag an
XOR accumulator, matching how direction actually composes across
multiple retime effects: each negative scalar flips the net direction,
so an even count of negatives cancels back to forward and an odd count
stays reversed — mirroring the magnitude accumulation (`scalar *=
Math.abs(ts)`) that was already correct.

### Test approach

New fixture `test/fixtures/resolve_double_reverse.otio`, modeled on the
existing `resolve_retime.otio` fixture's structure: one clip with two
`LinearTimeWarp` effects, `time_scalar` -1.0 then -2.0 (net: forward at
2x). New test in `test/parsers/otio.test.mjs` (a pure-logic parser test,
no Electron/native mocking needed) asserts the single resulting event's
`speedFactor` is `200`, not `-200`.

### Verification

`node --test test/parsers/otio.test.mjs`: 4/4 green. Mutation-proven:
reverted to `reversed = true`, reran — failed with
`AssertionError: -200 !== 200`, the literal bug reproduction; restored,
green again. Full `npm run build-verify` exit 0 (log: `/tmp/gate41.log`;
Python suite 250 passed, 7 skipped; XSS/XXE/fail-open gates clean).
Because `otio.js` is `src/`-facing renderer source (per CLAUDE.md, the
single source of truth copied by `build-renderer.js`), also ran
`npm run build:renderer` — exit 0, 377 files rebuilt into `dist/desktop/`
(git-ignored, confirmed via `git status` that no `dist/` changes leaked
into the diff). Before committing, normalized the file mode of
`test/parsers/otio.test.mjs` back to 644: editing it had picked up an
executable-bit flip from the pre-existing repo-wide mode anomaly (Audit
32), which is unrelated to this fix and was excluded from the commit's
diff the same way Iteration 40 excluded unrelated WIP content.

### Still open

- Only a two-negative stack was tested; longer chains (three-plus
  effects, or mixes of positive and negative scalars) aren't
  specifically covered, though the XOR fix is correct by construction
  for any count.
- A dedup-key gap surfaced during this iteration's scouting — the
  parser's final dedup step (`otio.js` ~line 846) keys on `[srcFile,
  recIn, recOut, clipName, trackIndex, disabled]`, omitting `srcIn`/
  `srcOut` — was not pursued, since an adjacent code comment states the
  conservative dedup is intentional; revisiting it needs a design
  decision, not a drive-by fix.
- A latch bug in `electron/native/pfx_native_engine.js`'s
  `NativeEngineManager.start()` (`_startAttempted` set permanently true,
  never reset by `stop()`, so a `stop()` → `start()` cycle can never
  respawn the binary) was flagged but confirmed unreachable in the
  current call graph — `electron/main.js` only calls `stop()` from
  `app.on('will-quit')` today, right before the process exits — so it's
  deferred as real-but-dormant rather than fixed.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Meechum/Edward OAuth, PFX session sync, `_activeWindow` guard, OCF
  proxy — Audit 40) remains untouched, unstaged, and out of scope.
- `CompanionBridge`'s other untested lifecycle paths (Audit 35), the
  heartbeat-interval lease race (Audit 36), the i18n gaps and
  `src/tools/visionscope/*` (Audit 30), and `render_queue.js`'s
  `_parseError` (Audit 1) all remain unchanged.

## Iteration 42 — media_engine.js's seek() used the exact NTSC fps instead of the nominal rate for timecode-to-frame conversion

### New species

The same "two-rate contract" bug class as Iteration 41 (`otio.js`), but
in a different layer: Electron main-process native-bridge glue rather
than a parser. It's also the first iteration to hit the CommonJS/ESM
boundary directly — the canonical fix (`nominalBase()` in
`src/scripts/modules/utils_time.js`) is unreachable from
`electron/native/media_engine.js` because the former is pure ESM and the
latter is pure CommonJS (`require('electron')`, `require('child_process')`
at module load), so the fix had to inline the same rounding rule locally
rather than import it — matching the existing precedent in
`electron/ipc.js` (`const r = Math.round(fps);`).

### Why this file, this iteration

`seek()` (`electron/native/media_engine.js`) is the function a player
session calls whenever a user (or another feature, like marker
navigation) jumps to a specific timecode. It converts `HH:MM:SS:FF` to a
frame count with `(h*3600 + m*60 + sec) * s.info.fps + f`, where
`s.info.fps` comes straight from the native `avf_bridge` probe — the
clip's *exact* frame rate (`23.976023976023978` for 24000/1001 NTSC
footage), not the nominal rounded rate (`24`) that HH:MM:SS:FF counting
is actually defined against. Every whole second of timecode undercounts
frames by a small fraction at NTSC rates; at one hour of timecode
(`01:00:00:00`) that fraction compounds to 86 frames — enough to land a
"seek to reel start" on the wrong frame. This is exactly the class of
bug Iteration 41 fixed in `otio.js`'s timecode arithmetic, just
resurfacing in a second, independent call site that never imported
`otio.js`'s fix.

### The fix

```js
if (timecode && s.info?.fps) {
  const [h, m, sec, f] = String(timecode).split(/[:;]/).map(Number);
  const nominalFps = Math.round(s.info.fps) || 24;
  s.state.frame = Math.round(((h * 3600 + m * 60 + sec) * nominalFps) + (f || 0));
}
```

`Math.round(s.info.fps) || 24` mirrors `utils_time.js`'s `nominalBase()`
(round to nearest integer, default 24 for invalid/zero input) without
requiring an ESM import into this CommonJS file — the same inline-round
pattern `electron/ipc.js` already uses elsewhere for the same reason.

### Test approach

New test `tests-js/mediaEngineSeekNominalFps.test.mjs`. `media_engine.js`
does `require('electron')` and `require('child_process')` at load time,
so outside Electron both need faking: `electron` resolves to a stub
object (`{ protocol: { registerSchemesAsPrivileged, handle } }`, enough
to satisfy the module's top-level calls), and `child_process.spawn` is
replaced with a factory returning an `EventEmitter`-based fake child
process whose `stdout` emits a canned `avf_bridge` JSON response
(`{ ok: true, fps: 23.976023976023978, codec: 'h264' }`) before closing —
both injected into `require.cache` before the first `require()` of the
module under test, the same pattern
`tests-js/downloadConflictAction.test.mjs` established for mocking
`electron`. The test then drives the module's own public API end to
end: `open()` to build a real session (asserting the session stores the
exact probed fps, as a sanity check that the fake plumbing worked), then
`seek({ timecode: '01:00:00:00' })`, asserting frame `86400` (nominal
24fps × 3600s), not `86314` (what the exact NTSC rate would floor to).

### Verification

Mutation-proven: with the fix in place, `node --test
tests-js/mediaEngineSeekNominalFps.test.mjs` — 1/1 green. Reverted
`seek()` to multiply by `s.info.fps` directly, reran — failed with
`AssertionError [ERR_ASSERTION]: 86314 !== 86400 seek must use nominal
fps (24) for HH:MM:SS:FF counting`, the exact bug reproduction; restored
the fix, green again. Full `npm run build-verify` exit 0 (log:
`/tmp/gate42.log`), including `tests-js/selfContained.test.mjs`'s
self-consistency gate (11/11) once the new test file was staged.
`electron/native/media_engine.js` is Electron main-process code, not
`src/`-facing renderer source per CLAUDE.md's one-source-two-targets
model, so `npm run build:renderer` was not required for this iteration
(consistent with Iterations 38-40's treatment of other Electron-only
native-process changes).

### Still open

- `electron/native/media_engine.js`'s working tree carries substantial
  pre-existing uncommitted WIP unrelated to this fix: `getOcfProxy()`/
  `getOcfProxyStatus()`, a "Problem 2" full-range OCF proxy render
  feature delegating to `resolve.renderOcfProxy`/
  `resolve.renderOcfProxyStatus` via the companion, already wired into
  the `HANDLED` set, `route()` dispatcher, and `module.exports` — plus a
  stray 100644→100755 mode-bit flip. Confirmed via `git show
  HEAD:electron/native/media_engine.js | grep getOcfProxy` (no match)
  that this predates and is independent of the `seek()` fix. Excluded
  from this commit via the same git-surgery blob-reconstruction
  technique (`git hash-object -w` + `git update-index --cacheinfo`
  against a clean HEAD-plus-fix blob) used in Iterations 39/40, and
  remains untouched, uncommitted, and out of scope.
- Only the `HH:MM:SS:FF` seek path was fixed; `stepFrame()` and other
  frame-count-based paths in the same file were not audited for the
  same bug class this iteration and should be checked in a future pass.
- The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
  start/stop `_startAttempted` latch (Iteration 41) remain unchanged.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Meechum/Edward OAuth, PFX session sync, `_activeWindow` guard, OCF
  proxy — Audit 40) remains untouched, unstaged, and out of scope.

## Iteration 43 — companion `_ocf_write_files` path-traversal guard was a naive string prefix check

### New species

The first security-class finding in this campaign rather than a timecode/
arithmetic bug, and the first iteration to leave the JS renderer codebase
entirely: this is in the Python companion server
(`companion/src/postflowx_companion/api.py`). Three consecutive scouting
rounds over `src/`'s renderer JS (see Still open below for the full list)
found nothing further, so this iteration pivoted to a previously-unswept
7191-line file in a different runtime/language entirely.

### Why this file, this iteration

`_ocf_write_files` is the handler behind the `ocfWriteFiles` companion API
call (dispatched at `api.py:375`), used to write FDL/AMF/QC text files —
filenames the renderer derives from shot/EDL/AAF-sourced names — under a
caller-specified `outputDir`. Its traversal guard was:

```python
abs_path = os.path.normpath(os.path.join(output_dir, rel_path))
if not abs_path.startswith(os.path.normpath(output_dir)):
    errors.append(f"Rejected path outside outputDir: {rel_path!r}")
    continue
```

`str.startswith` is a character-prefix test, not a directory-boundary
test. For `outputDir = "/Users/vfx/Delivery/ShowA"`, the sibling path
`/Users/vfx/Delivery/ShowA-VFX` also satisfies
`.startswith("/Users/vfx/Delivery/ShowA")` — no separator boundary is
checked. A `files[].path` of `"../ShowA-VFX/evil.txt"` normalizes to
exactly that sibling path, sails past the guard, and gets written with
attacker-controlled content (including binary, via the function's
`bytes`/`bytearray` branch) outside the intended delivery folder. The
sibling function `_ocf_copy_exr_delivery`, handling the identical
untrusted-shotName threat model two functions down in the same file,
already gets this right via `_safe_name_component` +
`_confined_join` (`api.py:6885-6907`) — `_ocf_write_files` was the one
write path in this file's delivery family that didn't reuse it.

### The fix

```python
try:
    # _confined_join does a real commonpath containment check, unlike a
    # naive startswith(outputDir) — which "/out".startswith would also
    # pass for the sibling "/out-evil", letting ../out-evil/x escape.
    abs_path = _confined_join(output_dir, rel_path)
except ValueError:
    errors.append(f"Rejected path outside outputDir: {rel_path!r}")
    continue
```

`_confined_join(base, *parts)` (already defined at module scope,
`api.py:6898`) resolves both `base` and the joined target via
`os.path.realpath` and checks `os.path.commonpath([base_r, target]) ==
base_r` — a real containment check immune to the prefix-collision that
broke the old guard, and immune to symlink escapes since it resolves
real paths first.

### Test approach

New `companion/tests/test_ocf_write_files.py`. `CompanionApi.__init__`
starts an HTTP server and background threads, which a unit test for one
pure file-write method shouldn't need to pay for, so the test constructs
the instance via `CompanionApi.__new__(CompanionApi)` and sets only
`self.config = CompanionConfig()` — the one attribute `_ocf_write_files`
touches indirectly through `_ok()`/`_error()`. Two cases: a traversal
attempt (`outputDir=<tmp>/ShowA`, `path="../ShowA-evil/evil.txt"`) must
report an error, write nothing to `written`, and leave no file on disk at
the sibling path; a legitimate nested relative path
(`"QC/report.txt"`) must still write correctly and appear in `written`,
guarding against the fix over-tightening into false rejections.

### Verification

Mutation-proven: with the fix in place, both tests pass. Reverted
`_ocf_write_files` to the original `startswith` check, reran — the
traversal test failed not on an assertion mismatch but by *actually
finding the exploit file written to disk* at
`.../ShowA-evil/evil.txt`, outside the test's tmp `outputDir` — the exact
vulnerability reproduced end to end; restored the fix, both tests green
again. Full `npm run build-verify` exit 0 (log: `/tmp/gate43.log`),
including all 259 companion pytest cases (252 passed, 7 skipped,
`test_ocf_write_files.py`'s 2 new cases among them) and the XSS/XXE/
fail-open static scan gates, all reported clean. `api.py` is Python
companion-server code, not `src/`-facing renderer source per CLAUDE.md's
one-source-two-targets model, so `npm run build:renderer` was not
required.

### Still open

- Three scouting rounds preceded this fix and swept, without finding a
  qualifying bug: `src/scripts/core/*` (14+ files), `utils_time.js`,
  `imf_j2k.js`, `projectFile.js` (near-full read — its
  `renameUnifiedProjectByName`/`cloneUnifiedProjectByName` were
  confirmed dead code, unreachable from the desktop UI, which itself
  calls `window.pfxPlatform.renameProject` via a separate
  `electron/ipc.js` implementation), `amf_convert.js`, `imf_player.js`,
  `i18n.js`, `crossTabQueueLease.js`, `playbackRouter.js`,
  `timelineModel.js`, `watchFolder/*`, `reviews/{autoCut,player,
  timeline}.js`, `eventDuration.js`, `nuke_import_script.js`,
  `smart_engine_settings.js`, `aaf_worker.js`, and `imf/j2kCodestream.js`.
  That surface is now considered heavily picked-over for this campaign's
  bug class and effort level.
- `companion/src/postflowx_companion/api.py` is 7191 lines; this
  iteration's scouting agent read it in full, but the rest of the
  companion package beyond this one file (`color/aces2_luts.py` and
  other modules under `companion/src/postflowx_companion/`) has not yet
  been swept and is a candidate area for a future iteration's scouting.
- The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
  start/stop `_startAttempted` latch (Iteration 41) remain unchanged.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Audit 40) and `media_engine.js`'s `getOcfProxy`/`getOcfProxyStatus`
  WIP (Audit 42) remain untouched, unstaged, and out of scope.

## Iteration 44 — cutdiff.js `tcToFrames` dropped every drop-frame timecode to 0

### New species

Back to the renderer, but a variant on the "two-rate contract" class from
Iterations 41–42: not nominal-vs-exact frame rate, but a second, distinct
timecode-parsing hazard — the drop-frame `;` vs. non-drop `:` field
separator — that every other timecode parser in this codebase already
handles, except this one.

### Why this file, this iteration

`src/scripts/modules/cutdiff.js` implements PostFlowX's Cut Diff engine:
given OLD and NEW event lists, it matches clips by identity and
classifies each as `NEW`/`EXTENDED`/`TRIMMED`/`CHANGED`/`UNCHANGED` by
comparing frame counts derived from `srcIn`/`srcOut`/`recIn`/`recOut`
timecode strings. Its own `tcToFrames`:

```javascript
export function tcToFrames(tc, fps) {
  if (!tc) return 0;
  const parts = String(tc).split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length !== 4) return 0;
  const [hh, mm, ss, ff] = parts;
  return ((hh * 60 + mm) * 60 + ss) * nominalBase(fps) + ff;
}
```

splits only on `:`. `utils_time.js`'s canonical `tcToFrames` — which this
same file already imports `nominalBase` from — instead does
`String(tc).replace(/;/g, ':').split(':')`, with the comment `"HH:MM:SS:FF"
or "HH;MM;SS;FF" (DF treated as NDF)`. `edl.js`, `xml.js`, and `ale.js`
all perform the same normalization for the same reason: a drop-frame EDL
represents its frame field with a semicolon, e.g. `"01:00:00;15"`.
`cutdiff.js` reimplements `tcToFrames` rather than delegating to the
shared one, and the reimplementation omits this normalization. A DF
timecode therefore splits into 3 parts, not 4, trips the
`parts.length !== 4` guard, and silently returns `0` — for every DF
in/out point on every clip, with no error surfaced anywhere. Since
`evFrames()` feeds all four of `srcInF`/`srcOutF`/`recInF`/`recOutF` from
this function, a DF-timecoded EDL run through Cut Diff can produce wrong
duration deltas and wrong match scores, silently misclassifying real
edits (e.g. an `EXTENDED` clip reading as `UNCHANGED` because both OLD
and NEW zeroed out to the same value).

### The fix

```javascript
export function tcToFrames(tc, fps) {
  if (!tc) return 0;
  // Drop-frame EDLs use "HH:MM:SS;FF" — normalise the semicolon to a colon so
  // DF timecodes split into 4 fields instead of silently failing the length
  // check below and collapsing every DF in/out point to 0.
  const parts = String(tc).replace(/;/g, ':').split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length !== 4) return 0;
  const [hh, mm, ss, ff] = parts;
  return ((hh * 60 + mm) * 60 + ss) * nominalBase(fps) + ff;
}
```

Mirrors the exact normalization already present in `utils_time.js`'s
implementation of the same function name.

### Test approach

The existing `tests-js/cutdiff.test.mjs` is part of the large pre-existing
uncommitted WIP surface (688+ dirty files) and is off-limits per this
campaign's standing rule, so the regression test lives in a new file,
`tests-js/cutdiff_dropframe_tc.test.mjs`. Five assertions: a `;`-separated
DF timecode on the hour field parses to the same frame count as its
`:`-separated NDF equivalent; the same holds for a DF separator on a
non-hour field; empty and malformed timecodes still safely return `0`
(guarding against the fix over-broadening); and an end-to-end
`computeCutDiff` case where a DF-timecoded clip grows from 120 to 180
frames must classify as `EXTENDED`, not silently fall through to
`UNCHANGED`.

### Verification

Mutation-proven: with the fix in place, all 5 assertions pass. Reverted
`tcToFrames` to the original `:`-only split, reran — 3 of 5 assertions
failed (both DF-parsing-equivalence checks, plus the end-to-end
`EXTENDED`-not-`UNCHANGED` classification), concretely reproducing the
bug; restored the fix, all 5 green again. Full `npm run build-verify`
exit 0 (log: `/tmp/gate44.log`), including all 259 companion pytest cases
(unaffected — this fix is JS-only) and the XSS/XXE/fail-open scan gates,
all clean. Since this iteration changes `src/`-facing renderer source,
`npm run build:renderer` was also run per CLAUDE.md's rule for UI-facing
changes; it succeeded (log: `/tmp/buildrenderer44.log`, 377 files rebuilt
into `dist/desktop/`).

### Still open

- The rest of the companion Python package beyond `api.py`
  (`companion/src/postflowx_companion/` submodules, `color/aces2_luts.py`)
  remains unswept, as flagged in Iteration 43.
- `cutdiff.js`'s `framesToTc` (the inverse, frames-to-timecode
  conversion) was read as part of this investigation but does not share
  this bug class — its only callers pass it numeric frame counts derived
  from `tcToFrames`'s own output, never a raw timecode string, so there is
  no separator to normalize.
- The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
  start/stop `_startAttempted` latch (Iteration 41) remain unchanged.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Audit 40) and `media_engine.js`'s `getOcfProxy`/`getOcfProxyStatus`
  WIP (Audit 42) remain untouched, unstaged, and out of scope.

## Iteration 45 — filters.js tcToFrames dropped every drop-frame-timecoded event from the pipeline

### New species

Same bug class as Iteration 44 (drop-frame `;` separator not normalized),
but a different, independently-implemented parser catching it — evidence
this class isn't isolated to one file.

### Why this file, this iteration

`src/scripts/modules/filters.js` implements the event pipeline
(Decompose → Flatten → Merge → Conform → Dedupe → VFX Marker → Extra
Handles → `filterValidTimecode`), run unconditionally by `runPipeline()`
on every set of parsed events. It has its own local `tcToFrames`,
independent of both `cutdiff.js`'s (fixed last iteration) and the
canonical `utils_time.js` one:

```javascript
function tcToFrames(tc, fps = 24) {
  if (!tc || typeof tc !== "string") return 0;
  const m = tc.match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return ((hh * 3600) + (mm * 60) + ss) * fps + ff;
}
```

The regex only matches `:`-separated fields. `edl.js` correctly preserves
a drop-frame source's `"HH:MM:SS;FF"` fields (e.g. `srcIn: "01:00:00;00"`),
so for a DF EDL this regex never matches, and `tcToFrames` silently
returns `0` for every in/out point. Every function in this file shares
this one helper — `dedupeBySrcRange`, `onlyVfxMarker`, `mergeOverlap`,
`addExtraHandlesForFastClips`, and `filterValidTimecode` all call it.
`filterValidTimecode`'s zero-length guard, `if (soF <= siF || roF <= riF)
return false;`, then sees `0 <= 0` for every DF event and discards it.
Net effect: importing any drop-frame source EDL causes `runPipeline()` to
silently drop every single event from its output — not misclassify them,
as in Iteration 44, but delete them outright — with no error or warning
anywhere in the chain.

### The fix

```javascript
function tcToFrames(tc, fps = 24) {
  if (!tc || typeof tc !== "string") return 0;
  // Drop-frame EDLs use "HH:MM:SS;FF" — normalise the semicolon to a colon so
  // DF timecodes still match this regex instead of returning 0 and getting
  // every event in the pipeline treated as zero-length by filterValidTimecode.
  const m = tc.replace(/;/g, ':').match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return ((hh * 3600) + (mm * 60) + ss) * fps + ff;
}
```

A single fix to the one shared helper corrects every call site in the
file at once.

### Test approach

The two existing test files for this module (`tests-js/filters.test.mjs`,
`tests-js/filtersVfxRename.test.mjs`) are both part of the pre-existing
uncommitted WIP surface and off-limits, so the regression test lives in a
new file, `tests-js/filters_dropframe_tc.test.mjs`. Four assertions: a
valid, non-zero-length DF-timecoded event survives `filterValidTimecode`;
the NDF equivalent also survives (parity check); a genuinely zero-length
DF event is still correctly dropped (guarding against the fix
over-broadening the accept condition); and a malformed timecode is still
safely dropped rather than crashing.

### Verification

Mutation-proven: with the fix in place, all 4 assertions pass. Reverted
`tcToFrames` to the original `:`-only regex, reran — exactly 1 of 4
failed (the DF-survival assertion), with the other 3 (NDF parity,
zero-length-DF rejection, malformed-input rejection) correctly
unaffected, confirming the test targets precisely the introduced bug.
Restored the fix, all 4 green again. Full `npm run build-verify` exit 0
on the first run (log: `/tmp/gate45.log`) — the new test file was staged
before running the gate this time, avoiding the self-containment-gate
hiccup from Iteration 44 — including all 259 companion pytest cases
(unaffected) and the XSS/XXE/fail-open scan gates, all clean. Since this
changes `src/`-facing renderer source, `npm run build:renderer` was also
run per CLAUDE.md's rule; it succeeded (log: `/tmp/buildrenderer45.log`,
377 files rebuilt into `dist/desktop/`).

### Still open

- The rest of the companion Python package beyond `api.py` remains
  unswept, as flagged in Iterations 43–44.
- Two independently-implemented `tcToFrames` functions have now been
  found with this exact bug class across two consecutive iterations
  (`cutdiff.js` in Iteration 44, `filters.js` here). Worth a dedicated
  future pass across `src/scripts/` to confirm no other module has its
  own uncoordinated timecode parser with the same gap — the four already
  confirmed correct are `utils_time.js`, `edl.js`, `xml.js`, `ale.js`.
- The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
  start/stop `_startAttempted` latch (Iteration 41) remain unchanged.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Audit 40) and `media_engine.js`'s `getOcfProxy`/`getOcfProxyStatus`
  WIP (Audit 42) remain untouched, unstaged, and out of scope.

## Iteration 46 — amf_convert.js's three separate tcToFrames copies all dropped drop-frame timecodes to 0

### New species

Same bug class as Iterations 44–45 (drop-frame `;` separator not
normalized before parsing), but this is now its THIRD independent
occurrence in three consecutive iterations, and the first time it shows
up more than once in the *same* file — `amf_convert.js` doesn't share one
`tcToFrames` helper across its own call sites, it has three separately
written copies of the identical buggy regex.

### Why this file, this iteration

`src/scripts/modules/amf_convert.js` handles VFX/AE export conversion.
It defines `tcToFrames` three times, independently:

1. At module scope, feeding the master-mode Nuke segment builder
   (`exportNukeNK`, ~line 6851):
   ```javascript
   const a = tcToFrames(h.recIn, fps);
   const b = tcToFrames(h.recOut, fps);
   const dur = Math.max(1, b - a);
   ```
2. Inside `__buildAEPCommonJSX`'s returned text, feeding
   `addTimingMarkers` (~line 4604) and a per-shot AE segment builder
   (~line 4810).
3. Inside `exportAEJSX`'s generated `.jsx` text, feeding the same timing
   logic once it's running inside After Effects/ExtendScript — this copy
   is doubly-escaped, since its regex source lives inside a template
   literal that itself gets written to disk as `.jsx` text:
   `/^(\\d+):(\\d+):(\\d+):(\\d+)$/`.

All three matched only `:`-separated fields. `edl.js`'s timecode regex —
read directly this iteration to confirm the claim — is
`const tcRe = /\b\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}\b/g;` (line 67), and
`recIn`/`recOut` are assigned verbatim from the last four matches
(`const [srcIn, srcOut, recIn, recOut] = last4;`, line 128) with no
normalization. So a drop-frame EDL's hits carry `"HH:MM:SS;FF"` straight
into `amf_convert.js`, and all three `tcToFrames` copies returned `0` for
every one of them — collapsing VFX comp segments in master-mode Nuke
export to zero-length, and AE timing markers/segments to zero-position
and zero-length, with nothing surfaced to the user.

### The fix

Same normalization pattern in all three copies:

```javascript
// module scope and __buildAEPCommonJSX copies
const m = String(tc || "").replace(/;/g, ':').match(/^(\d+):(\d+):(\d+):(\d+)$/);
```
```javascript
// exportAEJSX's doubly-escaped .jsx-text copy
var m = (tc||"").replace(/;/g, ':').match(/^(\\d+):(\\d+):(\\d+):(\\d+)$/);
```

The third fix has to be applied to the *pre-unescape* source form — the
enclosing template literal itself collapses `\\d` to `\d` at runtime
before the text is ever written to disk, so inserting `.replace(/;/g,
':')` ahead of the existing (still double-escaped) regex reproduces the
same behavior once the generated `.jsx` file is actually parsed by
ExtendScript.

### Test approach

`amf_convert.js` calls `document.addEventListener` at module scope, so it
cannot be `import()`'d under plain Node. Following the existing pattern
in `saveOutcome.test.mjs`/`toastContract.test.mjs`, the new
`tests-js/amfConvert_dropframe_tc.test.mjs` reads the file as text,
extracts each of the three `tcToFrames` function bodies with a regex, and
executes each in isolation via `new Function('tc', 'fps', body + 'return
tcToFrames(tc, fps);')`. For the `exportAEJSX` copy, the extracted body's
literal `\\d` is normalized to `\d` first (`rawBody.replace(/\\\\d/g,
'\\d')`), reproducing the one level of escape-processing the real
template literal performs at runtime — without this step the regex
matches a literal backslash instead of a digit and the test would report
a false failure even against already-fixed code. Ten assertions total:
all three definitions × (NDF still converts correctly, DF now converts
instead of silently returning 0, malformed input still safely returns 0
rather than crashing).

### Verification

Mutation-proven: with the fix in place, all 10 assertions pass. Reverted
all three `.replace(/;/g, ':')` insertions back to the original `:`-only
regexes (confirmed byte-identical to the pre-fix file via `git diff
--stat` showing zero diff), reran — exactly 3 of 10 failed, one
DF-specific assertion per definition, with the other 7 (NDF parity ×3,
malformed-input rejection ×3, plus the "exactly 3 definitions found"
count check) correctly unaffected. Restored the fix from a `/tmp` backup,
all 10 green again. Full `npm run build-verify` exit 0 on the first run
(log: `/tmp/gate46.log`) — the new test file was staged before running
the gate — including all 259 companion pytest cases (unaffected) and the
XSS/XXE/fail-open scan gates, all clean. Since this changes `src/`-facing
renderer source, `npm run build:renderer` was also run per CLAUDE.md's
rule; it succeeded (log: `/tmp/buildrenderer46.log`, 377 files rebuilt
into `dist/desktop/`).

### Still open

- Three consecutive iterations have now each found an independently-
  written `tcToFrames`/timecode parser with the exact same `;`-separator
  gap (`cutdiff.js` in Iteration 44, `filters.js` in Iteration 45, and
  three separate copies inside `amf_convert.js` here). That's a strong
  enough signal to warrant a dedicated, exhaustive sweep — rather than
  continued opportunistic discovery — of every remaining timecode-parsing
  regex across `src/scripts/` and `postflowx-adobe/` in a near-future
  iteration, specifically grepping for `:`-only timecode-splitting
  patterns not yet cross-checked against `utils_time.js`'s canonical
  normalize-then-split approach. Modules already confirmed correct:
  `utils_time.js`, `edl.js`, `xml.js`, `ale.js`, plus now-fixed
  `cutdiff.js`, `filters.js`, and `amf_convert.js`.
- The rest of the companion Python package beyond `api.py` remains
  unswept, as flagged in Iterations 43–45.
- The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
  start/stop `_startAttempted` latch (Iteration 41) remain unchanged.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Audit 40) and `media_engine.js`'s `getOcfProxy`/`getOcfProxyStatus`
  WIP (Audit 42) remain untouched, unstaged, and out of scope.

## Iteration 47 — timelineAutoInject.js's timecode regexes dropped drop-frame timecodes from the auto-injected timeline strip

### New species / Why this file, this iteration

`src/scripts/features/edl/timelineAutoInject.js` auto-injects a Timeline
Strip UI above the EDL Converter Event Table, so editors can see clip
positions at a glance without opening a separate timeline view. It's a
pure side-effect module — no exports, `try { boot(); } catch (e) {}` at
the bottom — that reads timecodes straight out of the Event Table's DOM
cells. This is the fourth consecutive iteration to find the exact same
drop-frame-separator bug class in a different, independently-written
timecode parser: `cutdiff.js`'s `tcToFrames` (Iteration 44), `filters.js`'s
`tcToFrames` (Iteration 45), `amf_convert.js`'s three separate
`tcToFrames` copies (Iteration 46), and now `timelineAutoInject.js`'s
regex trio plus a separate LOC-column fallback regex.

### The bug

```javascript
const TC_EXACT_RE = /^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/;
const TC_FIND_RE = /(\d{1,2}:\d{2}:\d{2}:\d{2})/g;

function extractFirstTc(s){
  const m = (s || '').toString().match(/(\d{1,2}:\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : '';
}
```

and, separately, inside `extractClips()`'s LOC-column fallback:

```javascript
const m = locText.match(/(\d{2}:\d{2}:\d{2}:\d{2})/);
```

`edl.js`'s own timecode regex
(`/\b\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}\b/g`) accepts `;` in every field
position and hands `recIn`/`recOut` through to the rendered Event Table
verbatim, so a drop-frame EDL's cells read `"HH:MM:SS;FF"`. Against the
`:`-only regexes above, `extractFirstTc()` found no match and returned
`''`, so `tcToFrames()` (which delegates to `extractFirstTc` before
matching `TC_EXACT_RE`) returned `NaN` for every real DF timecode.

Two call sites make this a real, reachable break rather than a
theoretical one:

- `extractClips()` (~line 201+) uses `tcToFrames` on the Rec In/Out
  column cell text as its highest-priority timing source (~line
  246-248: `s = tcToFrames((cells[colRecIn].textContent || '').trim(), fps)`),
  falling back to the LOC column (also broken) and then Src In/Out only
  if Rec timing is unavailable.
- `guessTimecodesFromRow()` (lines 161-179) joins a row's cell text and
  calls `collectTcs()`/`tcToFrames()` to derive start/end frames for
  heuristic row matching when column positions are ambiguous.

With all of these returning `NaN` for DF rows, the injected timeline
strip silently dropped or mis-positioned every drop-frame clip — with no
error surfaced to the editor.

### The fix

Widened all four regexes to accept `:` or `;` in every separator
position via `[:;]` character classes, matching `edl.js`'s own `tcRe`
pattern:

```javascript
// Drop-frame timecodes use "HH:MM:SS;FF" (semicolon before the frame field) —
// accept ':' or ';' in every field position, matching edl.js's own tcRe.
const TC_EXACT_RE = /^(\d{1,2})[:;](\d{2})[:;](\d{2})[:;](\d{2})$/;
const TC_FIND_RE = /(\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2})/g;

function extractFirstTc(s){
  const m = (s || '').toString().match(/(\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2})/);
  return m ? m[1] : '';
}
```

and the LOC-column fallback:

```javascript
const m = locText.match(/(\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2})/);
```

`tcToFrames()` itself needed no direct edit — it delegates entirely to
`extractFirstTc()` and `TC_EXACT_RE`, both fixed above.

This is a different normalization strategy than Iterations 44-46 (which
used `.replace(/;/g, ':')` before a `:`-only match): `timelineAutoInject.js`'s
regexes are used for both "does this look like a timecode" detection
(`TC_FIND_RE`, `looksLikeTc`) and value extraction, so widening the
character class in place was cleaner than adding a separate
normalization step at each of several call sites.

### Test approach

`timelineAutoInject.js` imports cleanly under plain Node — confirmed via
a direct `node -e` import test that printed "imported ok" with only a
caught-and-logged `ReferenceError` from the `try { boot(); } catch {}`
guard — but exposes zero `export` statements, so none of its internal
helpers are reachable from outside. New file
`tests-js/timelineAutoInject_dropframe_tc.test.mjs` extracts
`TC_EXACT_RE`, `TC_FIND_RE`, `extractFirstTc`, `collectTcs`, and
`tcToFrames` together as one contiguous text block (`tcToFrames` depends
on the others, so extracting them individually and re-wiring by hand
would be more fragile) via `src.indexOf(startMarker)...indexOf(endMarker)`,
then evaluates that block with `new Function`, mirroring the pattern
used for `amf_convert.js` in Iteration 46:

```javascript
const block = extractBlock('const TC_EXACT_RE', 'function parseIntLoose');
const harness = new Function(`${block}\nreturn { tcToFrames, extractFirstTc, collectTcs };`)();
```

5 assertions: NDF timecode still converts correctly, DF timecode
converts instead of returning `NaN`, malformed input safely returns
`NaN` (not a crash), `extractFirstTc` finds a DF timecode embedded in
surrounding text, and `collectTcs` finds all 4 DF timecodes in a
multi-timecode row rather than silently skipping them.

### Verification

Mutation-proven: reverted all four regexes to the original `:`-only
form, confirmed byte-identical revert via `git diff --stat` (zero diff),
reran the test — exactly 3 of 5 assertions failed (the DF-specific
conversion, embedded-extraction, and multi-hit-collection assertions),
while the NDF-parity and malformed-input assertions correctly stayed
green, confirming the test isolates the actual bug and not something
else. Restored the fix from a `/tmp` backup, reran — 5/5 green.

Full `npm run build-verify` gate passed on the first run (log:
`/tmp/gate47.log`), including all 259 companion pytest cases (252
passed, 7 skipped, unaffected — this fix doesn't touch companion code)
and the XSS/XXE/fail-open scan gates. Since this touches `src/`-facing
renderer code, `npm run build:renderer` was also run and succeeded (log:
`/tmp/buildrenderer47.log`, 377 files rebuilt into `dist/desktop/`).

### Still open

- Four consecutive iterations have now each found an independently-
  written timecode parser with the exact same `;`-separator gap
  (`cutdiff.js` Iteration 44, `filters.js` Iteration 45, `amf_convert.js`'s
  three copies Iteration 46, `timelineAutoInject.js`'s four spots here).
  That's a strong enough signal to warrant a dedicated, exhaustive sweep
  — rather than continued opportunistic discovery — of every remaining
  timecode-parsing regex across `src/scripts/` and `postflowx-adobe/` in
  a near-future iteration, specifically grepping for `:`-only
  timecode-splitting patterns not yet cross-checked against
  `utils_time.js`'s canonical normalize-then-split approach. Modules
  already confirmed correct: `utils_time.js`, `edl.js`, `xml.js`,
  `ale.js`, `cutdiff.js`, `filters.js`, `amf_convert.js`, and now
  `timelineAutoInject.js`.
- The rest of the companion Python package beyond `api.py` remains
  unswept, as flagged in Iterations 43–46.
- The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
  start/stop `_startAttempted` latch (Iteration 41) remain unchanged.
- The large in-progress WIP in `electron/preload.js`/`electron/ipc.js`
  (Audit 40) and `media_engine.js`'s `getOcfProxy`/`getOcfProxyStatus`
  WIP (Audit 42) remain untouched, unstaged, and out of scope.

## Iteration 48 — `_probe_ocf_file` truncated fractional camera fps, drifting `tc_out` by real seconds

**New species.** Iterations 44-47 all found variants of the same bug class:
a drop-frame timecode's `HH:MM:SS;FF` separator not being accepted by a
`:`-only regex/split. This iteration's bug is superficially similar (it's
also timecode arithmetic on camera footage) but is a genuinely different
mechanism: it's not about parsing the `;` separator at all — the string
splitting was already fine — it's about *how the fps value itself* is
turned into a frame-counting divisor. Fractional professional camera rates
(23.976, 29.97, 59.94fps — NDF timecode, no semicolons involved) must be
rounded to their nearest whole-number "nominal" base (24, 30, 60) before use
in frame arithmetic. Truncating instead of rounding is the bug.

**Why this file, this iteration.** `companion/src/postflowx_companion/api.py`
was confirmed git-clean via `git status --short`. `_probe_ocf_file` (lines
~2151-2280) is the ffprobe-based metadata extractor behind the VFX Pull
manual-relink flow — it runs `ffprobe` against a camera original file (ARRI,
RED, Sony, Blackmagic, etc.), parses the fps from `r_frame_rate`, and
computes a `tc_out` field from the embedded start timecode plus frame count.
Before this fix:

```python
fps = round(int(rfr[0]) / max(1, int(rfr[1])), 3) if len(rfr) == 2 else 24
...
tc_out = ""
if tc_known and nb_frames:
    try:
        def _tc2f(tc, f):
            p = tc.replace(";", ":").split(":")
            return sum(int(x)*m for x,m in zip(p,[f*3600,f*60,f,1]))
        def _f2tc(n, f):
            f = max(1, int(f))
            return "{:02d}:{:02d}:{:02d}:{:02d}".format(
                n//(f*3600), (n%(f*3600))//(f*60), (n//f)%60, n%f)
        tc_out = _f2tc(_tc2f(tc_in, int(fps)) + nb_frames, int(fps))
    except Exception:
        pass
```

`int(fps)` for `fps=23.976` gives `23`, not the nominal `24` — every
downstream frame calculation runs one frame count short per second of
footage. For `tc_in="01:00:00:00"`, `nb_frames=1000`, `fps=23.976`: buggy
`tc_out="01:00:43:11"`, correct `tc_out="01:00:41:16"` — a ~2 second drift on
exactly the camera rates this OCF-focused app is built to handle most.

This is the same class of defect `utils_time.js`'s `nominalBase()` was
written to prevent, with an explicit historical incident documented in its
comment: `tcToFrames('01:00:00:00', 23.976)` returning `86313` instead of
`86400` (a one-hour timecode landing 87 frames / 3.6 seconds short of
itself). The Python companion package already has its own correct instance
of this same convention, just not wired into `_probe_ocf_file`: the
module-level `_tc_to_frames`/`_frames_to_tc` functions (lines ~6927-6948)
both compute `int(round(fps))` internally, and are proven correct at
`fps=23.976` via `_resolve_clip_metadata`'s existing test
(`test_resolve_probe_clips.py::test_clip_metadata_computes_tc_range_and_identity`,
asserting `tcOut == "09:47:44:20"`).

**The fix.** Rather than changing the local `int(fps)` calls to
`int(round(fps))` (which would have been sufficient but leaves a second,
independently-maintained reimplementation of frame-timecode conversion in
the file), the local `_tc2f`/`_f2tc` helper functions were deleted entirely
and `_probe_ocf_file` now delegates to the existing correct, tested
module-level functions:

```python
# ── TC out ─────────────────────────────────────────────────────────
# Delegate to the module-level _tc_to_frames/_frames_to_tc (also used
# by _resolve_clip_metadata) rather than a local reimplementation —
# both already round fps to its nominal whole-frame base internally,
# so a 23.976fps clip correctly uses 24 rather than truncating to 23.
tc_out = ""
if tc_known and nb_frames:
    try:
        tc_out = _frames_to_tc(_tc_to_frames(tc_in, fps) + nb_frames, fps)
    except Exception:
        pass
```

This both fixes the bug and removes 8 lines of duplicate logic in favor of
functions the codebase already trusts and tests elsewhere.

**Test approach.** New file `companion/tests/test_probe_ocf_tc_out.py`.
`_probe_ocf_file(self, path, name, ext, ffprobe_path=None)` accepts an
explicit `ffprobe_path` override, so the test bypasses ffprobe discovery
entirely by passing a fake path and monkeypatching `subprocess.run` to
return a synthetic ffprobe JSON payload (`r_frame_rate`, a `timecode` tag,
`nb_frames`). Since `_probe_ocf_file` doesn't touch `self` anywhere in its
body, the test constructs the API object via `CompanionApi.__new__(CompanionApi)`
rather than the real `__init__` (which spins up an HTTP server and
background threads — unnecessary and slow for this unit test). Three cases:

```python
def test_tc_out_uses_nominal_base_at_23_976_fps(monkeypatch):
    info = _probe_with_fake_ffprobe(monkeypatch, 24000, 1001, nb_frames=1000, timecode="01:00:00:00")
    assert info["tcOut"] == "01:00:41:16"

def test_tc_out_uses_nominal_base_at_29_97_fps(monkeypatch):
    info = _probe_with_fake_ffprobe(monkeypatch, 30000, 1001, nb_frames=1000, timecode="01:00:00:00")
    assert info["tcOut"] == "01:00:33:10"

def test_tc_out_unaffected_at_integer_fps(monkeypatch):
    info = _probe_with_fake_ffprobe(monkeypatch, 24, 1, nb_frames=1000, timecode="01:00:00:00")
    assert info["tcOut"] == "01:00:41:16"
```

Expected values were independently computed via a standalone Python
round/truncate simulation (not by running the fixed code and copying its
output) before the test was run, to avoid a test that just echoes back
whatever the implementation happens to produce.

**Verification.** Mutation-proven: reverted `_probe_ocf_file` to the
original local `_tc2f`/`_f2tc`/`int(fps)` code, reran the new test file —
both fractional-fps cases failed with exactly the predicted drifted values
(`01:00:43:11` and `01:00:34:14` respectively), the integer-fps control
passed unaffected (24fps has no truncation to lose). Restored from a `/tmp`
backup, confirmed byte-identical to the fixed version via `diff`, reran —
3/3 green. Full `npm run build-verify` gate: exit 0, 262 companion pytest
cases (255 passed, 7 skipped), XSS/XXE/fail-open scans all clean. No
`src/`-facing renderer code touched, so `npm run build:renderer` was
correctly skipped.

**Still open.** First confirmed instance of the "truncate instead of round
fractional fps" bug class — unlike the now-exhausted drop-frame-separator
class, its extent elsewhere in the codebase is unknown. A dedicated grep
sweep for `int(fps)` / `int(<fps-like-variable>)` feeding frame-count
arithmetic (as opposed to the already-correct `int(round(fps))` pattern)
across the rest of `companion/src/postflowx_companion/` is the natural next
target. `otio.js`'s dedup-key gap and `pfx_native_engine.js`'s start/stop
latch (Iteration 41) remain deferred/off-limits respectively.

Commits: `98e0dd2`.

## Iteration 49 — `xml.js` Scale X/Scale Y wrongly also set the uniform `transform.scale`

**New species.** Not a timecode bug at all — this iteration's find is in
XMEML *effect parameter* parsing. The mechanism is a substring-exclusion
guard that only accounts for one of two forms a lookup key can take: it
correctly excludes the unspaced `"scalex"`/`"scaley"` (from a
`<parameterid>` tag) but not the spaced `"scale x"`/`"scale y"` (from a
`<name>` tag fallback), because `String.includes` requires a contiguous
substring match and the space breaks it.

**Why this file, this iteration.** `src/scripts/parsers/xml.js` was
confirmed git-clean via `git status --short`. `extractFxFromClipitem`
(starts at line 359) parses each `<filter><effect>`'s `<parameter>` list
for `Basic Motion` effects into a `transform` object (`scale`, `scaleX`,
`scaleY`, `rotation`, etc.), which is spread directly into the parser's
output event (`...(fx || {})` around line ~1220, so callers read
`event.transform.scale`, not a nested `fx` key). Each parameter's lookup
`key` is `getText(param, 'parameterid')` if present, else falls back to the
lowercased `getText(param, 'name')` text (line ~476):

```js
const pid = (getText(param, 'parameterid', '') || '').trim().toLowerCase();
const pname = (getText(param, 'name', '') || '').trim().toLowerCase();
const key = pid || pname;
```

Before this fix, the generic/uniform-scale branch was:

```js
if (key.includes('scale') && !key.includes('scalex') && !key.includes('scaley')){
  let scaleVal = readNum(val);
  scaleVal = chooseMotionValueFromKeys(scaleVal, kfs, readNum, sameNum, n => Math.abs(Number(n)) > 0.001);
  if (scaleVal != null) t.scale = scaleVal;
  if (kfs) t.scaleKeys = kfs;
}
if (key === 'scalex' || key === 'scale x') {
  const v = readNum(val); if (v != null) t.scaleX = v > 10 ? v / 100 : v;
}
if (key === 'scaley' || key === 'scale y') {
  const v = readNum(val); if (v != null) t.scaleY = v > 10 ? v / 100 : v;
}
```

The axis-specific branches immediately below already handle both the
unspaced AND spaced forms (`key === 'scalex' || key === 'scale x'`), but
the generic branch's exclusion only checked the unspaced substrings. A real
XMEML file with `<parameter><name>Scale X</name><value>150</value></parameter>`
and no `<parameterid>` produces `key = "scale x"`. `"scale x".includes('scale')`
is `true` (fires the generic branch) and `"scale x".includes('scalex')` is
`false` (the space breaks the substring match, so the exclusion never
fires) — so a Scale X parameter wrongly set BOTH `transform.scaleX` (from
the axis-specific branch, correctly) AND `transform.scale` (from the
generic branch, incorrectly), corrupting any downstream logic that treats
`transform.scale` as "this clip has a single uniform scale factor."

**The fix.** Added an explicit equality check for the spaced axis-specific
forms to the generic branch's guard (line 478):

```js
if (key.includes('scale') && !key.includes('scalex') && !key.includes('scaley') && key !== 'scale x' && key !== 'scale y'){
```

`key !== 'scale x'`/`'scale y'` is a safe addition here — `key` is already
`.trim().toLowerCase()`'d, and the axis-specific branches use the exact
same two literal strings for their own matching, so this closes the gap
using the same vocabulary the file already relies on elsewhere, rather than
introducing a new pattern.

**Test approach.** New file `test/parsers/xml_scale_axis.test.mjs`.
`parseXMEML` is `xml.js`'s only export (confirmed via
`grep -n "^export\|module.exports"`), and `extractFxFromClipitem` is a
private, unexported function, so the test builds a minimal synthetic XMEML
XML string (one `sequence` → `clipitem` with a `Basic Motion` `<filter>`
containing a single `<parameter>`) and asserts through the real parser's
output (`res.events[0].transform`), following the existing
`xml.test.mjs`'s inline-string-builder pattern rather than adding a new
fixture file for a single-parameter scenario:

```js
test('a Scale X parameter sets transform.scaleX only, not transform.scale', () => {
  const res = parseXMEML(buildWithMotionParam('Scale X', '150'));
  const tf = res.events[0].transform;
  assert.equal(tf.scaleX, 1.5, '150 > 10, so normalized to a 1.5 multiplier');
  assert.equal(tf.scale, undefined, 'an axis-specific param must not also set the uniform scale');
});
```

Plus the equivalent for `Scale Y` (`75` → `0.75`), plus a plain `Scale`
control case (`150` → `tf.scale === 150`, `tf.scaleX`/`scaleY` both
`undefined`) confirming the fix doesn't disable the intended generic-scale
case it was never meant to touch.

**Verification.** Mutation-proven: reverted the guard to its original
unfixed condition (full-file backup at `/tmp/xml_js_backup_iter49.js`),
reran the new test — the Scale X and Scale Y cases failed exactly as
predicted (`tf.scale` was `150`/`75` instead of `undefined`), the plain
`Scale` control still passed. Restored from backup, confirmed byte-identical
via `diff`, reran — 3/3 green. Full `npm run build-verify` gate: exit 0
(log: `/tmp/gate49.log`), new test's assertions visible in the log, all
pre-existing Node test-runner suites and companion pytest (255 passed, 7
skipped) unaffected, XSS/XXE/fail-open scans clean. This is a `src/`-facing
renderer change per `CLAUDE.md`, so `npm run build:renderer` was run
afterward (377 files regenerated into the git-ignored `dist/desktop/`, not
committed).

**Still open.** The same spaced-vs-unspaced key mismatch could plausibly
recur for other axis-pair `Basic Motion`/`Crop`/`Center` parameters in
`xml.js` that mix `<parameterid>` and `<name>`-only forms — not yet swept
beyond Scale. Iteration 48's `int(fps)` grep sweep across the rest of
`companion/src/postflowx_companion/` remains pending (its two known
instances in `standard_media_backend.py`/`aaf_export.py` are still dirty
files, off-limits). `otio.js`'s dedup-key gap and `pfx_native_engine.js`'s
start/stop latch (Iteration 41) remain deferred/off-limits respectively.

Commits: `739ac3a`.

## Iteration 50 — `filters.js` used a raw fractional fps as a frame-counting divisor

**New species.** Back to the timecode-arithmetic family (Iterations 44-47),
but a new file: the "nominal frame-rate base" bug — using a raw fractional
fps (e.g. AAF's `24000/1001 = 23.976023976023976...`) directly as a
frame-counting divisor instead of rounding it to its nominal whole-frame
base first — had already been fixed in `cutdiff.js`, `eventDuration.js`,
`edl_export.js`, and codified as the shared `nominalBase()` helper in
`utils_time.js`. `src/scripts/modules/filters.js` was the one sibling
timecode module in the pipeline that still used the raw fps directly.

**Why this file, this iteration.** `src/scripts/modules/filters.js` was
confirmed git-clean via `git status --short`. Its two private helpers
`tcToFrames`/`framesToTC` convert between `"HH:MM:SS:FF"` strings and frame
counts for every stage of the pipeline (`mergeOverlap`, `dedupeBySrcRange`,
`addExtraHandlesForFastClips`, `onlyVfxMarker`'s marker-offset math). Before
the fix:

```js
function tcToFrames(tc, fps = 24) {
  if (!tc || typeof tc !== "string") return 0;
  const m = tc.replace(/;/g, ':').match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return ((hh * 3600) + (mm * 60) + ss) * fps + ff;
}

function framesToTC(fr, fps = 24) {
  fr = Math.round(fr || 0);
  const totalSec = Math.floor(fr / fps);
  const ff = fr % fps;
  ...
}
```

AAF imports attach each event's raw `EditRate` as its `fps` (confirmed via
`aaf_worker.js`/`aaf_wasm.js`), so an NTSC-rate AAF reaches `filters.js`
with `fps = 23.976023976023976...`, not `24`. At that fps,
`framesToTC(30, fps)` computes `30 % 23.976023976023976... =
6.023976023976024`, producing the malformed timecode
`"00:00:01:6.023976023976024"` instead of `"00:00:01:06"`. Any downstream
`tcToFrames()` call on that malformed string can't match its frame group
(`\d+` doesn't match a decimal) and silently falls back to `0`, so a
`mergeOverlap` boundary computed via `framesToTC` at a fractional fps fails
to line up with a well-formed literal timecode for the same nominal frame,
and clips that should merge don't.

**The fix.** Imported the existing `nominalBase()` helper from
`utils_time.js` and used it in place of the raw `fps` in both helpers'
divisor/multiplier positions:

```js
import { nominalBase } from './utils_time.js';

function tcToFrames(tc, fps = 24) {
  ...
  return ((hh * 3600) + (mm * 60) + ss) * nominalBase(fps) + ff;
}

function framesToTC(fr, fps = 24) {
  const base = nominalBase(fps);
  fr = Math.round(fr || 0);
  const totalSec = Math.floor(fr / base);
  const ff = fr % base;
  ...
}
```

This is the same fix shape already applied to `cutdiff.js`/`eventDuration.js`/
`edl_export.js` — reusing the shared helper rather than reimplementing
rounding logic locally.

**Test approach.** New file `tests-js/filters_fractional_fps.test.mjs`.
`tcToFrames`/`framesToTC` are private, unexported functions, so the test
exercises them indirectly through `onlyVfxMarker` (which computes a
marker's `recIn` via `framesToTC` from its `inFrames` offset) and
`mergeOverlap` (which compares a computed `recOut` against the next
clip's `recIn` via `tcToFrames`).

The first attempt at this test compared two identical literal timecode
strings on both sides of the `mergeOverlap` boundary, which is a dead
mutation test: both sides run through the exact same deterministic
`tcToFrames` formula on the exact same literal input, so they're equal
whether or not `nominalBase()` is applied — the test would pass against
both the buggy and the fixed code. The rewritten version instead obtains
one side of the comparison as the module's actual `framesToTC`-computed
output (via `onlyVfxMarker`'s marker path) and compares it against an
independently-authored literal string for the same nominal frame, so the
two sides only agree when the computed value is well-formed:

```js
test('onlyVfxMarker: a fractional AAF fps still produces a well-formed 2-digit frame field', () => {
  const evs = [{ ..., fps: AAF_NTSC_FPS, _markers: [{ name: 'VFX', color: 'Red', inFrames: 30 }] }];
  const out = onlyVfxMarker(evs, { color: 'All', fps: AAF_NTSC_FPS });
  assert.equal(out[0].recIn, '00:00:01:06');
});

test('mergeOverlap: a framesToTC-computed boundary still matches the literal recIn at a fractional fps', () => {
  const computedTC = onlyVfxMarker([{ ... }], { color: 'All', fps: AAF_NTSC_FPS })[0].recIn;
  const evs = [
    { ..., recOut: computedTC, srcOut: computedTC },
    { ..., recIn: '00:00:01:06', srcIn: '00:00:01:06', ... },
  ];
  const merged = mergeOverlap(evs);
  assert.equal(merged.length, 1);
});
```

**Verification.** Mutation-proven: reverted both helpers to their original
raw-`fps` form (confirmed against `git show HEAD:src/scripts/modules/filters.js`
byte-for-byte via `diff`), reran `node --test
tests-js/filters_fractional_fps.test.mjs` — both tests failed as predicted
(`pass 0, fail 2`): the `onlyVfxMarker` case produced the exact malformed
`"00:00:01:6.023976023976024"` string, and the `mergeOverlap` case merged
0 events instead of 1 because the malformed computed TC's frame group
failed to parse and fell back to 0 frames. Restored the fix, reran —
`pass 2, fail 0`. Full `npm run build-verify` gate green (Node test-runner
suites, companion pytest 255 passed/7 skipped, all three security gates
clean) plus `npm run build:renderer` (377 files regenerated, required
since this is a `src/`-facing change).

**Still open.** `aaf_worker.js:559,785`/`aaf_wasm.js:39,48,62` are cited
above as the source of the raw fractional `EditRate` reaching `filters.js`
based on a prior scouting pass, not independently re-confirmed this
iteration. Iteration 48's `int(fps)` sweep across
`companion/src/postflowx_companion/` and Iteration 49's spaced-vs-unspaced
axis-key sweep beyond `Scale` both remain pending. `otio.js`'s dedup-key
gap and `pfx_native_engine.js`'s start/stop latch (Iteration 41) remain
deferred/off-limits respectively.

Commits: `f0bf7d7`.

## Iteration 51 — drop-frame timecode misclassification at 23.976fps (companion/api.py)

**New species.** Every prior iteration in this loop fixed a frame-rate
*base* bug (raw fractional fps used where a rounded nominal base was
required). This is a different species: a drop-frame *classification*
bug — deciding whether to format timecode with a semicolon (drop-frame)
or colon (non-drop) separator based on an incorrect frame-rate
membership test.

**Why this file.** `git status --short` for `companion/src/postflowx_companion/api.py`
was empty (clean) before editing, confirming it was safe to modify per
the standing off-limits-for-dirty-files rule. `api.py` is the companion
server's HTTP handler layer; the two affected call sites are on the OCF
preview/seek timeline-TC path and the batch-pick resolve path, both of
which hand timecode strings to DaVinci Resolve's Set/GetCurrentTimecode
API.

**The fix.** Before, at both call sites:
```python
drop_frame = fps in (29.97, 59.94, 23.976)   # api.py:3104
...
_drop = fps in (29.97, 59.94, 23.976)         # api.py:4057
```
23.976 has no drop-frame variant — SMPTE drop-frame only exists for the
30-based NTSC rates (29.97/59.94), where whole-frame counting drifts from
wall-clock time fast enough to require periodic frame-number skipping.
This project's own `src/scripts/modules/utils_time.js` already codifies
this (`{ fps: 23.976, dfCapable: false }` vs. `{ fps: 29.97, dfCapable: true }`/
`{ fps: 59.94, dfCapable: true }`), but the Python companion side had this
separate, incorrect inline check.

After — new shared helper in `proxy_service.py`, modeled on the existing
tolerance-based pattern in `aaf_export.py:132-134`
(`abs(fps - 29.97) < 0.02`, `abs(fps - 59.94) < 0.02`), which avoids
fragile exact-float-equality checks against literals like `29.97` when
`fps` may arrive via slightly different rounding paths:
```python
def _is_drop_frame_rate(fps: float) -> bool:
    """True only for the 30-based NTSC rates (29.97/59.94) that have a drop-frame
    variant. 23.976 has no drop-frame form -- it always uses non-drop timecode."""
    return abs(fps - 29.97) < 0.02 or abs(fps - 59.94) < 0.02
```
Both `api.py` call sites now read `_is_drop_frame_rate(fps)`, and the
function was added to `api.py`'s existing import line from
`.proxy_service`.

**Test approach.** Existing candidate test files (`test_ocf_seek_tc.py`,
`test_tc_helpers.py`) were pre-existing dirty/`??` WIP and off-limits, so
a new file was created: `companion/tests/test_drop_frame_rate.py`, with
four cases — `_is_drop_frame_rate` returns `False` for 23.976, `True` for
29.97/59.94, `False` for whole-number rates (24/25/30), and
`_seconds_to_timecode(3604.4166, 23.976, _is_drop_frame_rate(23.976))`
produces a colon-only (no semicolon) 4-field timecode.

**Verification.** Mutation-proven: temporarily reverted
`_is_drop_frame_rate`'s body to the buggy
`return fps in (29.97, 59.94, 23.976)` form (isolated to the `return`
line only, verified via `s.count(old) == 1` before replacing, to avoid
corrupting the docstring), reran the new test file —
`2 failed, 2 passed`, exactly as predicted: `test_23976_is_not_drop_frame`
failed (`assert True is False`), and
`test_seconds_to_timecode_uses_colon_separator_at_23976` failed with the
actual malformed output `'01:00:00;19'`. Restored the fix, reran —
`4 passed, 0 failed`. Full `npm run build-verify` gate green: companion
pytest 259 passed/7 skipped (up from 255/7 pre-fix), Node `test:node`/
`test:js` unaffected, XSS/XXE/fail-open gates clean. Companion-only
(Python) change, so `npm run build:renderer` was not required.

**Still open.** `_drop` in the batch-pick function (`api.py` ~line 4057)
appears write-only — no further reference found in the enclosing function
via grep — a pre-existing oddity left untouched as out of scope. All
"still open" items carried from Iteration 50 (the `aaf_worker.js`/
`aaf_wasm.js` raw-EditRate citations, Iteration 48's `int(fps)` sweep,
Iteration 49's spaced-axis-key sweep, the deferred `otio.js`/
`pfx_native_engine.js` items) remain unchanged.

Commits: `fc04c95`.

## Iteration 52 — audio-QC windowed-scan position tracking (src/tools/bwav/app.js)

**New species.** Iterations 48-51 all fixed frame-rate/timecode-domain
bugs (raw-fractional-fps-as-base, drop-frame classification, etc). This
is a different species entirely: an audio-QC windowing/position-tracking
bug in the bwav tool's quick-scan path, with no fps or timecode involved.

**Why this file.** `git status --short -- src/tools/bwav/app.js` was
empty (clean) before editing, confirming it was safe to modify per the
standing off-limits-for-dirty-files rule. `runAudioScanQuick()` is the
quick-scan entry point the bwav tool's UI calls to report clipping
segments and digital hits on large PCM WAV/BWF files without reading the
entire file — it bounds work to a `MAX_BYTES` window (or, for large
files, a "start" window plus a separate "end" window near the tail,
skipping the middle) for performance.

**The fix.** Before, inside the per-window scan loop, a single
`scannedFrames` counter was incremented once per frame across both
windows and reused directly as the reported file-frame position:
```js
scannedFrames += 1;
...
if (clipRuns[c] === 0) clipRunStart[c] = scannedFrames;
...
hits.push({ channel: c+1, frame: scannedFrames, timeSec: scannedFrames / sr, delta: d });
```
Since the "start" and "end" windows are physically disjoint slices of the
file, `scannedFrames` — a simple running count of frames sampled so far —
does not correspond to the frame's real position once the "end" window is
reached; a hit near the true tail of a large file was reported as if it
sat immediately after the "start" window ended. Additionally, `clipRuns[c]`/
`clipRunStart[c]` were only ever flushed once, after the entire scan
completed, so a clip run still open at the tail of the "start" window
carried straight into the "end" window's first samples, producing one
merged (and mislabeled) segment out of what should have been two
unrelated bursts.

After: each window computes its own frame offset from its own byte
offset (`windowFrameOffset = Math.round((w.off - startOff) / frameSize)`),
and every reported `fileFrame` is `windowFrameOffset + f + 1` (window-local
frame index, converted to this window's real file position) rather than
the shared cumulative counter. `scannedFrames`/`scannedSeconds` (which
legitimately need the cumulative total-frames-sampled count, a different
concept from file position) were left untouched. The clip-run
flush-and-reset block was moved from after the whole scan loop to the end
of every per-window iteration, so a run open at a window's tail is closed
out immediately rather than being able to splice onto the next window's
head across a physically disjoint gap.

**Test approach.** `app.js` is a plain browser script — no ES module
exports, and DOM-dependent code executes at top-level load — so it can't
be imported directly into a Node test the way an ES module could.
`runAudioScanQuick` and its dependencies (`dbfsFromAmp`,
`channelLayoutGroups`) are pure, though — no DOM access — so
`tests-js/bwavAudioScanQuick_windowOffset.test.mjs` extracts just those
three function bodies by name via regex + brace-counting (not fixed line
numbers, since the fix changes line counts and the extraction needs to
survive `git stash` mutation-testing), concatenates them, and evaluates
via `new Function(...)` to get a callable reference. This sidesteps the
DOM-shim approach `toastContract.test.mjs` uses (`new Function('window',
'document', ..., MODULE_SRC)` with linkedom) since none of the code under
test touches the DOM. Two tests: (1) a fake file built with `HALF * 2 +
1000` bytes of PCM data (forcing two disjoint windows per the same
`MAX_BYTES`/`half` math the scanner itself uses) with a 3-frame clipping
burst planted at a known offset inside the "end" window — asserts the
reported hit frame/timeSec and clip-segment `startFrame` match the
burst's real file position, not a start-window-adjacent one, while
`scannedSeconds` still reflects total frames sampled; (2) a fake file
with two independent 3-frame clip bursts, one at the tail of the "start"
window and one at the head of the "end" window — asserts these surface as
two separate 3-frame segments, not one merged 6-frame segment.

**Verification.** Mutation-proven via two scoped `git stash push -- src/tools/bwav/app.js`
/ `git stash pop` cycles (chosen over hand-editing to guarantee the
"before" state was exactly the pre-fix code, and scoped to this one file
given the repo's large body of pre-existing unrelated uncommitted WIP,
verified undisturbed via `git stash list` before/after). With the fix
reverted: `hits.frame` reported `5243881` (the wrong,
start-window-adjacent position) instead of the expected `5244131` (the
correct real file position), and the two genuinely-separate clip bursts
merged into `1` segment instead of the expected `2` — both exactly the
predicted failure modes. With the fix restored, both tests passed. Full
`npm run build-verify` gate: initially failed with exit 1 —
`selfContained.test.mjs`'s "no new test file is left out of git" gate
correctly caught the new test file before it was staged; after
`git add`ing both `src/tools/bwav/app.js` and the new test file, a
full rerun passed with exit 0 (companion pytest 259/7 unaffected, Node
`test:node`/`test:js` all green including the two new bwav tests, all
three security gates clean). Since this fix lives under `src/tools/`,
which `build-renderer.js`'s `SHARED_ITEMS` list copies into
`dist/<target>/`, `npm run build:renderer` was run (unlike Iteration 51's
companion-only Python change) and produced a clean 377-file desktop
build.

**Still open.** All items carried from Iteration 51 (`_drop` write-only
oddity in `api.py`, Iteration 48's `int(fps)` sweep, Iteration 49's
spaced-axis-key sweep, the `aaf_worker.js`/`aaf_wasm.js` raw-EditRate
citations, the deferred `otio.js`/`pfx_native_engine.js` items) remain
unchanged. This iteration's own scope was narrow (quick-scan window
position tracking only) — the bwav tool's other scan paths and heuristics
(silence detection, dBFS calculations, the digital-hit delta/threshold
logic itself) were read for context but not independently audited for
further species of bugs; that remains a candidate for a future iteration.

Commits: `c94f9db`.

## Iteration 53 — Nuke export timecode used raw fractional fps as frame-base (src/scripts/modules/amf_convert.js)

**New species — no, converged instance.** This is not a new species; it's
the same fps-fractional-as-frame-base bug already fixed in `filters.js`
(Iteration 50) and `eventDuration.js`, now converged into a third file
that hadn't picked up the shared fix yet.

**Why this file.** `amf_convert.js` was on this iteration's 84-file
non-dirty candidate list (built via `comm -23` between a full source-file
listing and `git status --short`'s dirty-file list). A scouting agent
flagged `tcToFrames(tc, fps)`'s frame-count arithmetic; I independently
re-verified the claim by reading the actual function, its caller
(`exportNukeNK()`), and confirming `nominalBase()`'s existence and export
signature in `utils_time.js` before touching anything.

`amf_convert.js` actually defines `tcToFrames` **three times** — this
became clear only after finding a pre-existing test,
`tests-js/amfConvert_dropframe_tc.test.mjs`, which already extracts and
tests all three copies for an unrelated, already-fixed bug (drop-frame
semicolon handling). Definition #1 is module-scope, directly-executed JS
used by `exportNukeNK()`'s master-mode segment/Root-range building — the
one actually fixed this iteration. Definitions #2 and #3 live inside
`__buildAEPCommonJSX()` and `exportAEJSX()`, both of which build and
return template-literal strings of ExtendScript/JSX *source text* meant
to be written out and executed inside Adobe After Effects' own scripting
engine — a different execution context that cannot `import` from
`utils_time.js`. Both embedded copies contain the identical `* fps`
multiplication bug, but fixing them requires either interpolating a
pre-rounded fps value into the generated script text or embedding an
equivalent rounding helper inline in the ExtendScript itself — scoped out
of this iteration as a "still open" item rather than attempted alongside
the module-scope fix, consistent with prior iterations' narrow-scope
pattern.

**The fix.** Added `import { nominalBase } from "./utils_time.js";` and
changed definition #1's return statement:

```js
// Before
return ((hh * 3600 + mm * 60 + ss) * fps) + ff;

// After
return ((hh * 3600 + mm * 60 + ss) * nominalBase(fps)) + ff;
```

`fps` here is `base?.fps || DEFAULT_FPS` — the EDL parser's raw fractional
NTSC rate (23.976/29.97/59.94) when the source is NTSC-family, not the
nominal whole-frame base (24/30/60) a timecode's `FF` field is actually
counted against. A 23.976fps EDL's `"00:00:05:00"` (5 real seconds, which
should be exactly 120 frames at the 24-frame nominal base) was instead
computed as `119.88` — a non-integer frame count that propagated into
`recInF`/`recOutF`/`durF` for every shot segment and into
`rootFirst`/`rootLast` (the exported `.nk` script's `Root.first_frame`/
`Root.last_frame`), corrupting the generated Nuke script's frame range for
any project shot on a fractional NTSC rate.

**Test approach.** `amf_convert.js` touches `document` at module scope,
so it can't be `import()`'d under plain Node — same constraint as the
pre-existing `amfConvert_dropframe_tc.test.mjs`. The new test,
`tests-js/amfConvert_fractionalFpsTcToFrames.test.mjs`, extracts just
definition #1's body as text via the same regex pattern and evaluates it
with `new Function`, providing a local `nominalBase` stub matching the
real helper's rounding behavior, then asserts 23.976/29.97/59.94fps
timecodes convert to whole-frame counts on their nominal base (120/108000/
60 respectively) while whole-number fps and drop-frame-semicolon handling
remain unaffected. Also had to update the pre-existing
`amfConvert_dropframe_tc.test.mjs`: its generic harness evaluates all
three `tcToFrames` copies with only `tc`/`fps` in scope, so once
definition #1 started referencing `nominalBase`, that pre-existing test's
own run against definition #1 threw `ReferenceError: nominalBase is not
defined`. Fixed by adding the same `nominalBase` stub to that harness's
evaluated scope — a required, minimal change to keep an existing
regression test green, not a weakening of what it verifies (it still
independently confirms the DF-semicolon behavior for all three
definitions, including #1, exactly as before).

**Verification.** Mutation-tested via `git stash push -- src/scripts/modules/amf_convert.js`
/ `git stash pop` (scoped to this one file, verified via `git status`
before/after given the repo's large body of pre-existing unrelated
uncommitted WIP). With the fix reverted, the new test failed exactly as
predicted: `119.88` instead of `120` at 23.976fps, `107892` instead of
`108000` at 29.97fps, `59.94` instead of `60` at 59.94fps. With the fix
restored, all 8 assertions in the new test passed, and the updated
pre-existing test's all 10 assertions (3 definitions × 3 timecode cases,
plus the definition-count check) also passed. Full `npm run
build-verify` gate: `npm run build:renderer` run first (this file lives
under `src/scripts/modules/`, part of `build-renderer.js`'s
`SHARED_ITEMS`), producing a clean 377-file desktop build (git-ignored,
not committed); full gate then exit 0 — companion pytest 259/7 unaffected,
Node `test:node`/`test:js` all green including both amf_convert tests, all
three security gates clean.

**Still open.** The two ExtendScript/JSX-embedded `tcToFrames` copies
(`__buildAEPCommonJSX()` ~line 4353, `exportAEJSX()` ~line 5917) share the
identical fractional-fps-as-multiplier bug but run inside Adobe After
Effects' ExtendScript engine as generated text, not as JS in this module —
left unfixed pending a decision on whether to interpolate a pre-rounded
fps into the generated script text or embed an inline rounding helper in
the ExtendScript itself. A fourth helper —
`tcToFramesLocal(tc, fps=__QT_FPS)` at ~line 1564, inside a "QT custom
controls (24fps, 1-based frames)" section — was surfaced by the same grep
sweep and checked: `__QT_FPS` is `const __QT_FPS = 24` (line 1267), a
hardcoded integer, not a parser-derived fractional rate, so this helper
never receives a fractional fps and is ruled out as an instance of this
bug. All items carried from Iteration 52 remain pending and unchanged.

Commits: `aae10a9`.

## Iteration 54 — Proxy cache collided across projects when a sidecar was missing (companion/src/postflowx_companion/proxy_service.py) — new species

**New species.** All prior iterations (48–53) were fps-base/timecode
arithmetic bugs in the renderer's EDL/AAF/AMF domain. This one is a
companion-server proxy-cache **identity** bug: a project-isolation failure,
not a numeric one.

**Why this file.** `proxy_service.py` was on this iteration's 84-file
non-dirty candidate list. A scouting agent flagged `_proxy_cache_path()`
(lines 148–156) as a candidate; I independently re-verified by reading the
function itself, `_sidecar_matches_target()`, `_proxy_target_stem()`/
`_proxy_display_name()` (confirming the stem is display-title-derived, not
identity-derived), `_write_proxy_sidecar()` (confirming it swallows
exceptions and only runs after an encode completes), and by dispatching a
read-only sub-investigation into the two real callers —
`start_proxy_playback()` (~line 3101) and the `_adopt_named_proxy_cache()`/
`_proxy_cache_is_valid()` chain it calls into — to confirm the collision is
actually reachable end-to-end, not just theoretically possible in the one
function.

**The bug.** `_proxy_cache_path()`'s reuse condition was:

```python
if not clean_target.exists() or _sidecar_matches_target(clean_sidecar, folder, cpl_path) or not clean_sidecar:
    return clean_target
return root / f"{stem}__{key}.mp4"
```

`stem` comes from `_proxy_target_stem()` → `_proxy_display_name()`, which
uses the CPL's `contentTitle`/`annotation` (or the QuickTime filename stem)
— there is no content-identity hash in it. Two different projects (distinct
watch folder + distinct CPL) can therefore produce the exact same
`clean_target` path if they share a display title (a generic reel name, a
recurring show title, etc.). The trailing `or not clean_sidecar` meant that
whenever the existing file at that shared path had no sidecar — which
happens whenever `_write_proxy_sidecar()`'s `write_text` call raised (it's
wrapped in a bare `try/except: pass`, line ~437) or the process was
killed/crashed between finishing an encode and writing the sidecar, or the
file is a legacy pre-sidecar proxy — the code treated "identity unknown" as
"identity confirmed, safe to reuse" and handed back the same shared path
for the unrelated new project.

Read together with the caller chain (confirmed via sub-agent
investigation): `start_proxy_playback()` gets this path back as
`cache_path` and immediately calls `_adopt_named_proxy_cache()`, which
either (a) if `_proxy_cache_is_valid(desired)` is already true, adopts the
foreign file **unconditionally** — no identity check at all — rewrites its
sidecar to claim the *current* folder/CPL, and serves it straight to the
player (a silent wrong-video-served bug with zero content verification),
or (b) otherwise falls through unchanged and lets `_transcode_worker`
encode a fresh proxy onto that same path, overwriting/destroying whatever
the foreign project had there. `_proxy_cache_is_valid()` (lines 350–371)
never checks folder/CPL identity itself — only legacy-name pattern, file
size, IAB-audio-validation version, and a `proxyQuality` string match
against `_current_proxy_quality()` (default `'turbo'`) — so under the
default quality setting the missing-sidecar case reliably routes to the
overwrite outcome; under a quality configuration where the empty
`cached_quality` fallback happens to pass, it routes to the silent-serve
outcome and additionally re-registers the mislabeled file in the
content-addressable fingerprint registry (`_registry_register`), spreading
the wrong identity further. Notably, `_adopt_named_proxy_cache()`'s own
legacy-sidecar-scanning loop (lines ~192–212) *does* check
`folderPath`/`cplPath` before reusing/renaming a sidecar-less file —
proving the codebase already recognized this exact hazard and guarded
against it in that adjacent path, just not in `_proxy_cache_path()` itself.

**The fix.** Removed `or not clean_sidecar` from the condition in
`_proxy_cache_path()`. A missing or non-matching sidecar now always falls
through to the folder+CPL-keyed path
(`root / f"{stem}__{key}.mp4"`, `key = _stable_proxy_cache_key(folder,
cpl_path)` — a sha1 of the resolved folder path, resolved CPL path, and the
CPL file's size/mtime), which is unique per project regardless of any
shared display-name collision, instead of the ambiguous shared path.

**Test approach.** New file `companion/tests/test_proxy_cache_path_identity.py`,
following this repo's existing pytest conventions
(`companion/tests/test_proxy_service_watch.py`'s `tmp_path`-based,
direct-import style). `test_missing_sidecar_does_not_reuse_foreign_clean_target`
builds two distinct `(folder, cpl_path)` pairs sharing one `contentTitle`,
has the first "claim" the clean path by writing a file with no sidecar
(simulating the crash/failed-write scenario), then asserts the second
project's call returns a different, keyed path rather than the same one.
`test_matching_sidecar_still_reuses_clean_target` is the companion
non-regression check: same project, sidecar written and matching, still
gets the same clean path back — confirming the fix doesn't force
unnecessary key-suffixed proxies for the legitimate single-project case.

**Verification.** Mutation-tested via
`git stash push -- companion/src/postflowx_companion/proxy_service.py` /
`git stash pop` (scoped to this one file). With the fix reverted, the
collision test failed exactly as predicted — both projects' calls resolved
to the identical `Reel1_proxy.mp4` path; the reuse test was unaffected.
With the fix restored, both new tests passed. Full `npm run build-verify`
gate: companion-only Python change, so `npm run build:renderer` was not
required (consistent with Iteration 51's precedent); full gate exit 0 —
companion pytest 261 passed / 7 skipped (268 collected, up from 259/7 —
the two new tests), Node `test:node`/`test:js` unaffected, all three
security gates clean.

**Still open.** All items carried from Iterations 52–53 remain pending and
unchanged. `_proxy_cache_is_valid()` still performs no folder/CPL identity
check of its own — it relies entirely on callers (now correctly, after
this fix) already having resolved an unambiguous path via
`_proxy_cache_path()`/`_adopt_named_proxy_cache()` first. Adding a
belt-and-suspenders identity check inside `_proxy_cache_is_valid()` itself
was considered but not pursued this iteration, since the actual reachable
bug was fully closed by the narrower, more targeted fix in
`_proxy_cache_path()`.

Commits: `2474017`.

## Iteration 55 — Cross-tab leader election had a TOCTOU race in acquire/release and heartbeat renewal (src/scripts/core/crossTabQueueLease.js) — new species

**New species.** Iterations 48–53 were renderer fps/timecode arithmetic
bugs; Iteration 54 was a companion-server cache-identity bug. This one is a
**concurrency race** — a time-of-check-to-time-of-use (TOCTOU) gap in a
cross-browser-tab leader-election protocol, the first concurrency-class
finding in this audit series.

**Why this file.** `crossTabQueueLease.js` was on this iteration's 84-file
non-dirty candidate list (`/tmp/clean_src2.txt`), independently re-verified
clean via `git status --short -- src/scripts/core/crossTabQueueLease.js`
before editing. It implements single-leader-tab election for proxy-build
job submission: an IndexedDB store (`pfx_queue_lease_v1`/`leases`, key
`queue_leader`) holds `{queueLeaderTabId, leaseUntil, heartbeat}`, with a
`BroadcastChannel('pfx_queue_lease')` for immediate cross-tab notification
and a 15s TTL / 5s heartbeat as the fallback path.

**The bug.** `acquireLease()`, `releaseLease()`, and `_startHeartbeat()`'s
periodic renewal all read the lease via `_getLease()` (a `readonly`
transaction) and wrote it back via `_setLease()` (a separate `readwrite`
transaction), with an `await` boundary between the two. IndexedDB
guarantees transactions against the same object store are serialized
relative to *each other*, but that guarantee does nothing across two
separate transactions issued by the same logical operation with a gap in
between — a second tab's transaction can land in that gap. Concretely: two
tabs racing on startup could both read "no lease exists" before either's
write landed, and both believe they'd won leadership; and a throttled or
backgrounded tab's heartbeat could read a since-superseded lease (one a
peer tab had already taken over) and then unconditionally overwrite that
peer's fresh takeover with its own stale renewal, silently reverting
leadership without either tab's in-memory `_isLeader` state reflecting
reality.

**The fix.** Rewrote all three operations to perform their read-then-write
inside a single `readwrite` IndexedDB transaction — the `get()` request's
`onsuccess` handler conditionally calls `store.put()` synchronously within
the same transaction, and the transaction's `oncomplete` (not the
individual request) resolves the outer promise. Because IndexedDB
serializes `readwrite` transactions against the same store end-to-end, no
other transaction can observe or act on state between this read and this
write. `acquireLease()`/`releaseLease()` were fixed first (commit
`8362fd5`); tracing `_startHeartbeat()` afterward showed it had the
identical two-transaction shape (`_getLease()` then `_setLease()`) and the
identical exposure, fixed the same way as a follow-up (this iteration's
second commit, `7e122bf`).

**Test approach.** `tests-js/crossTabQueueLeaseRace.test.mjs` runs the
module's actual IIFE source unmodified inside a `node:vm` sandbox against a
hand-rolled fake IndexedDB (no `fake-indexeddb` package is installed in
this repo). The pre-existing test added with the acquire/release fix races
two tabs' `acquireLease()` calls against a writeLock-chained fake IDB and
asserts exactly one wins — but its `setInterval` stub is a total no-op, so
it structurally cannot exercise `_startHeartbeat()`. For the heartbeat fix,
rather than trying to reproduce the race via precise microtask-count timing
(fragile, and this repo's existing fake IDB isn't built for step-control),
I added a second, purpose-built **gated** fake IndexedDB that captures
transactions into a `pending` queue instead of auto-running them, exposing
`pause()`, `runPendingAt(i)` (splice-and-run by FIFO index), `getRaw()`, and
`patchRaw()` (to force the stored lease into an already-expired state so a
second tab's plain `acquireLease()` call is a legitimate takeover attempt,
not a no-op against a still-valid lease). The test: tab A acquires the
lease and starts its heartbeat (captured via a `setInterval` stub that
records the callback instead of no-op'ing it); the lease is patched to
expired; the store is paused; A's heartbeat callback and B's `acquireLease()`
are invoked concurrently; the queued transactions are then driven one at a
time via `runPendingAt(0)` to force a specific interleaving. The final
assertion is invariant-based, not winner-based —
`bBelievesItWon === currentOwnerIsB` — because under forced FIFO ordering
the *fixed* code can legitimately let either tab end up as owner depending
on which atomic transaction runs first; what must never happen, on any
code shape, is a tab locally believing it won while the persisted store
disagrees (a split-brain state that would let a non-leader tab submit jobs
it thinks it's authorized to submit).

**Verification.** Mutation-tested by reverting only the heartbeat fix
(`git stash push -- src/scripts/core/crossTabQueueLease.js`) and rerunning:
the new test failed exactly as predicted — `tabB believes it won=true but
store owner is B=false`, i.e. A's stale two-transaction heartbeat renewal
clobbered B's legitimate takeover after B's atomic transaction had already
landed. The pre-existing acquire/release test was unaffected (that part of
the file wasn't reverted). Restoring the fix (`git stash pop`) made both
tests pass again. Full `npm run build-verify` gate: exit 0, all Node/JS
tests green, companion pytest untouched (261 passed / 7 skipped, 268
collected), all three security scan gates clean.

**Still open.** All items carried from Iterations 52–54 remain pending and
unchanged. Not pursued this iteration: the `BroadcastChannel`
`leader_released`-triggered `acquireLease()` retry path (line ~193) and the
`beforeunload` handler's `releaseLease()` call both go through the
now-fixed `acquireLease`/`releaseLease` functions directly, so they inherit
this fix without needing separate changes — confirmed by reading both call
sites, not just assumed.

Commits: `8362fd5`, `7e122bf`.

## Iteration 56 — cutdiff.js's identity-key normalization was documented but never implemented (src/scripts/modules/cutdiff.js) — new species

**New species.** The first six iterations of this audit series found
numeric/rounding bugs (48–50), a timecode-classification bug (51), a
position-tracking bug (52), a fps-fractional-as-frame-base bug (53), a cache
identity collision (54), and a concurrency TOCTOU race (55). This iteration
is a distinct "match-key normalization gap" species: a function whose own
inline comment describes a normalization step it is supposed to perform,
but the implementation silently omits that step entirely. The bug is not a
miscalculation — it's a documented intent that was never wired up, and
nothing in the type system or test suite (until now) caught the gap between
comment and code.

**Why this file.** `src/scripts/modules/cutdiff.js` was on the
Iteration-56 clean-candidate whitelist (`git status --short` empty before
editing) and was flagged by a scouting pass as having a self-contradicting
comment: `identityKey()`'s doc comment explicitly names an example
(`101-08-06/01_A` and `101-08-06/01_AB` should cluster together) that the
function, as written, does not produce. Independently re-read the full file
and re-ran `git status --short` before touching anything, per the standing
"trust but verify" practice for scouting-agent findings.

**The bug.** `computeCutDiff()` indexes every OLD event into a `Map` keyed
by `identityKey(ev.clipName, ev.reel)`, then looks up NEW-event candidates
by the same key — if the key for a NEW event has zero entries in that map,
the event is unconditionally classified `NEW` (`src/scripts/modules/cutdiff.js`,
the `if (!best)` branch off `oldIndex.get(key)`). Editorial re-cuts commonly
relabel a shot's angle/take suffix between passes (an editor swaps from a
single angle `_A` to a combined/alternate angle `_AB`, or similar) without
the clip otherwise changing identity. Because `identityKey()` did no
suffix-stripping, `101-08-06/01_A` (OLD) and `101-08-06/01_AB` (NEW)
produced different map keys, so the NEW event found no OLD candidates and
was misreported as a brand-new shot — even though the surrounding
duration/srcIn-based scoring logic (`_matchScore`, `durTol`/`srcTol`) was
fully capable of correctly classifying it as EXTENDED/TRIMMED/CHANGED/
UNCHANGED once a candidate was found. The multi-candidate-per-key design
(`oldIndex.get(key)` returns an array, each entry independently `used`-
tracked) already exists specifically to support multiple takes/angles
sharing one identity — the stripping was the only missing piece to make
angle-relabeled shots participate in that matching at all.

**The fix.** Added `ANGLE_SUFFIX_RE = /_[A-Za-z]+\d*$/` and applied it to
the trimmed `clipName` inside `identityKey()` before the key is built. The
regex requires a letter immediately following the underscore (`_A`, `_AB`,
`_A2` all match; optional trailing digits after the letter are allowed),
which deliberately excludes purely numeric trailing suffixes like `_010` or
`_020` — those are shot/take counters, not angle labels, and must remain
distinct identities. Display fields are unaffected: `_makeResult()` spreads
the original `ev` object for all output (`clipName`, etc.), so the stripped
key is used only for matching, never shown to the user.

**Test approach.** `tests-js/cutdiff.test.mjs` — three new assertions
appended after the existing fractional-fps block: (1) the core bug
scenario — an angle-suffix change (`_A` → `_AB`), same reel, NEW duration
longer than OLD, must classify EXTENDED (proving the event was matched, not
treated as NEW); (2) a same-suffix identity check — an unchanged
angle-suffixed clip name must classify UNCHANGED, not NEW, confirming the
stripped key still round-trips correctly through the full
duration/srcIn-tolerance classification logic, not just the presence/
absence of a match; (3) a negative-case guard — two clips differing only by
a purely numeric suffix (`SHOT_010` vs `SHOT_020`) must remain distinct
identities and classify NEW, verifying the regex's letter-required
constraint doesn't over-strip and silently collapse genuinely different
shots into one identity. All three were checked structurally against the
pre-existing test fixtures (`'A'`, `'B'`, `'C'`, `'SHOT_010'`) before
writing, to confirm no regression risk.

**Verification.** Mutation-tested per the established methodology: reverted
only the fix via `git stash push -- src/scripts/modules/cutdiff.js`
(pathspec-scoped, not a full-tree stash) and reran
`node tests-js/cutdiff.test.mjs` — the new angle-suffix test failed exactly
as predicted (`101-08-06/01_AB` classified NEW instead of EXTENDED; 52
passed, 1 failed), while the identical-suffix and numeric-suffix-guard
assertions were unaffected by the revert (they exercise paths the pre-fix
code already handled correctly, by coincidence for (2) and by design for
(3)). Restored the fix (`git stash pop`) and confirmed `git status --short`
showed exactly the two intended files modified, then reran the full suite:
all 53 assertions passed. Ran the complete `npm run build-verify` gate
after restoring the fix: exit 0 — Node/JS tests green, companion Python
suite untouched and green (261 passed / 7 skipped, 268 collected), all
three security scan gates (XSS/XXE/fail-open) clean.

**Still open.** All items carried from Iterations 52–55 remain pending and
unchanged. Not pursued this iteration: whether other identity-forming call
sites elsewhere in the codebase (outside `cutdiff.js`) have similar
documented-but-unimplemented normalization gaps — this was scoped to the
one flagged, verified instance.

Commits: `05c6f0f`.

## Iteration 57 — ref-clip early-return skipped marker collection (new species)

**New species.** The first control-flow early-exit bug in this series: a
clip-type branch resolves its target and recurses to produce output, then
returns before reaching the parser's shared post-processing step, so
per-node data attached only to that branch's own node (not to anything
inside what it recurses into) is silently dropped. Distinct from
Iterations 48–50 (fps-base rounding), 51 (drop-frame misclassification), 52
(windowed-scan position tracking), 53 (fractional-rate-as-frame-base), 54
(cache identity collision), 55 (cross-tab TOCTOU race), and 56
(match-key normalization gap) — none of those involve a code path bypassing
shared logic for one branch of a type dispatch.

**Why this file.** `src/scripts/parsers/fcpxml.js` is the FCPXML parser,
confirmed imported by `src/scripts/ui.js`, `src/scripts/prep_mark.js`, and
`src/scripts/features/reviews/index.js` — it is on the live import graph
for both the desktop and extension targets. This finding was originally
scouted against `src/scripts/parsers/fcpxm.js` (missing the trailing "l").
Independent verification searched the codebase for importers of that exact
filename and found none — it is dead code, unreachable from any entry
point — so the finding was not reported as-is. Instead, the equivalent
`<ref-clip>` marker-handling logic was located in the correctly-named,
live `fcpxml.js` and re-verified there before being written up. This is
recorded here as a "trust but verify" example: a scouting pass can
correctly identify a real bug pattern while pointing at the wrong (dead)
file, and independent verification is what catches that before a
non-genuine finding gets reported.

**The bug.** The `<ref-clip>` branch (used for compound-clip and multicam
instances dropped on a timeline) resolves the referenced `<media>`'s
`<sequence>` and recurses into it to produce this ref-clip's output rows,
then `return`s. The parser's own marker-collection logic — which reads
`<marker>` children directly under the current clip node and attaches them
to that clip's output row — lives further down in the same function, in
the shared per-clip-node code path all other clip types (`asset-clip`,
`clip`, `gap`, etc.) fall through to. Because the ref-clip branch returns
early, `<marker>` elements that are direct children of the `<ref-clip>`
node itself (as opposed to markers inside the referenced sequence, which
the recursion already handles correctly) were never read at all — they
were not misattributed or duplicated, just entirely absent from the
output. This mirrors an editorial reality: markers are commonly added to
the outer compound-clip instance on the main timeline (e.g. a reviewer
flagging "check this multicam angle at frame X" on the timeline instance)
rather than by opening the compound clip and marking its internal
sequence.

**The fix.** Extracted the parser's existing per-clip marker-collection
logic into a new top-level `collectClipMarkers(node, recInF, srcF, durF,
fps)` helper, so the same logic can be invoked from more than one call
site without duplicating it. In the `<ref-clip>` branch, added a
`startLen = out.length` snapshot immediately before the recursive call,
then — after recursion returns — called `collectClipMarkers` on the
ref-clip node itself and attached any results to `out[startLen]` (the
first row the recursion produced), before the branch's own `return`. The
original marker-collection call site in the main per-clip block was
switched to call the same extracted helper, so the two paths cannot drift
out of sync again.

**Test approach.** Added
`'a marker on a <ref-clip> node itself is not dropped'` to
`test/parsers/fcpxml.test.mjs`: an inline FCPXML with a `<media>` compound
clip wrapping a `<sequence>`/`<asset-clip>`, referenced by a top-level
`<ref-clip>` that itself carries a direct `<marker start="2s"
value="REVIEW"/>`. Asserts exactly one output row (the ref-clip itself
produces no row; only its resolved content does) and that the marker is
present on that row. Writing this test surfaced a pre-existing gap in
`test/_setup.mjs`: it shims `DOMParser` and `chrome.runtime.getURL` for
Node test runs but was missing the browser `CSS` global that this parser's
ref-clip resolution needs (`` media[id="${CSS.escape(ref)}"]` ``) — so any
`ref-clip` node hitting the Node test suite before this fix threw
`ReferenceError: CSS is not defined` internally, meaning ref-clip parsing
had never actually been exercised by an automated test. Added a minimal,
test-only `CSS.escape` polyfill to `test/_setup.mjs`, consistent with that
file's documented policy of shimming only what the parsers touch, never
shipping the shim.

**Verification.** Mutation-tested per the established methodology:
reverted only the fix via `git stash push --
src/scripts/parsers/fcpxml.js` (pathspec-scoped, not a full-tree stash)
and reran `test/parsers/fcpxml.test.mjs` — the new ref-clip-marker test
failed exactly as predicted (marker absent from the output row), while all
6 other tests in the file continued to pass. Restored the fix (`git stash
pop`) and confirmed via `git status --short` that only the three intended
files (`src/scripts/parsers/fcpxml.js`, `test/_setup.mjs`,
`test/parsers/fcpxml.test.mjs`) were modified before re-running: all 7
tests passed. Ran the complete `npm run build-verify` gate: exit 0 —
Node/JS tests green, companion Python suite untouched and green (261
passed / 7 skipped), all three security scan gates (XSS/XXE/fail-open)
clean. Separately, after `git stash pop` surfaced a large, alarming
`git status` diff across hundreds of unrelated repo files, this was
investigated via `git diff --summary` on a sample file and confirmed to be
pre-existing, content-free file-permission (mode-bit) noise (`100644 =>
100755`) unrelated to this change — left untouched, not staged, not
committed.

**Still open.** All items carried from Iterations 52–56 remain pending and
unchanged. `src/scripts/parsers/fcpxm.js` (no trailing "l") is confirmed
dead code — unimported anywhere in the app — and is permanently excluded
from future scouting passes to avoid re-reporting a non-genuine finding
against it.

Commits: `514bd19`.

## Iteration 58 — Pass 7 TC-Out matching compared against the raw, retime-uncompensated srcOut (new species)

**New species.** All eight prior species (Iterations 48–57) involved a
single wrong value, a missing check, or a race condition. This one is
different in shape: the *correct* value already existed and was already
computed in the same function, but a fix for retime compensation had only
been threaded into one of two places that needed it — a partial
propagation of a derived/corrected value across multiple use sites.

**Why this file.** `src/scripts/smart/smartOcfMatcher.js` implements the
OCF-to-timeline-event matching cascade used to auto-link source camera
files to editorial events, scoring candidates through roughly a dozen
sequential passes (filename/UMID exact match, camera-name pattern,
reel/timecode exact match, TC-In proximity, TC range overlap, roll prefix,
subfolder path, TC-Out proximity, FPS match, fuzzy name similarity) into a
single 0–100 confidence score bucketed into SAFE / REVIEW_NEEDED /
NOT_RECOMMENDED / MISSING. It contains a deliberate embedded null byte
(Map-key delimiter) that makes plain `grep -n`/`file` silently misreport
it as binary — `grep -na` (force text) is required to read it, a
workaround already established in this audit series.

**The bug.** Pass -1 (near the top of `matchOcfToEvent`) computes
`effectiveSrcOut` for constant-speed retimed events: for a shot with
`speed !== 100`, the event's own `srcOut` field is derived from the
*timeline* duration, not the *native source* duration the OCF file's
timecode actually spans — e.g. a 50%-speed slow-mo shot has an OCF file
whose real duration is double the timeline duration. `effectiveSrcOut`
corrects for this and is already used by Pass -1's own `inRangeHdl`
check a few lines later. Pass 7, several dozen lines further down,
independently recomputes a TC-Out proximity delta
(`_frameDelta(ocfFile.tcOut, event.srcOut, fps)`) for its own `+8`
confidence bonus — but it reads the raw `event.srcOut` instead of
`effectiveSrcOut`. For a retimed shot, this means Pass 7 compares the
OCF file's real TC-Out against a timecode that the retime math says
shouldn't apply, and can miss its bonus on a match that is, in fact,
exactly correct. The practical effect: a correctly-matched retimed OCF
file can score REVIEW_NEEDED instead of SAFE, adding unnecessary manual
review burden specifically on slow-mo/overcrank shots — exactly the kind
of shot where correct OCF linking matters most for VFX pulls.

**The fix.** Changed Pass 7's delta computation to
`_frameDelta(ocfFile.tcOut, effectiveSrcOut || event.srcOut, fps)`,
reusing the exact value Pass -1 already computes rather than
recalculating or re-deriving anything — the `|| event.srcOut` fallback
preserves existing behavior for non-retimed events, where
`effectiveSrcOut` is `undefined`.

**Test approach.** Added
`tests-js/smartOcfMatcher_retimeTcOut.test.mjs`: constructs a 50%-speed
retimed event (timeline-duration `srcOut` of `01:00:02:00`) matched
against an OCF file whose real TC-Out (`01:00:04:00`) is exactly double,
consistent with the retime. Asserts both the bucket (`MATCH_STATUS.SAFE`)
and the exact numeric `confidence` (83), pinning Pass 7's specific `+8`
contribution rather than just the pass/fail boundary. Getting to this
scenario required first hand-mapping the entire scoring cascade (roughly
a dozen passes, lines ~235–528) via direct source reading plus an ad-hoc
debug script printing the full result object including `_debug` and
`reasons`, which surfaced two non-obvious interactions: (1) a floor
override just after Pass 7,
`if (camNameHit && (tcExact || inRange)) score = Math.max(score, 85)`,
that would force the score to ≥85 regardless of Pass 7's outcome if the
reel/filename matched the camera-name regex — an initial test draft used
a camera-style reel (`'A001C002'`) and passed at `confidence: 100`
*whether or not the fix was present*, a flaw caught only via mutation
testing before any commit, not by the test passing; and (2) Pass 1's
`'Reel exact + TC-In exact'` bonus (`+60`) and Pass 3's `else if`
TC-In-proximity sub-branch (`+15`) both apply simultaneously for an
exact-TC reel-exact match, because Pass 3's dup-guard only gates its own
first `if` branch and the `+15` sub-branch is an independent `else if`
sibling — meaning the pre-fix baseline for the chosen scenario is 75
(Pass 1 + Pass 3's sub-branch), not the lower number an initial
hand-calculation assumed. The final scenario was redesigned around both
discoveries: a bare `'A001'` reel (fails the camera-name regex, so
`camNameHit` stays falsy and the floor override never fires), no
`ocfFile.path` (skips the subfolder-match pass), and no `ocfFile.fps`
(skips the FPS-match pass) — isolating Pass 7 as the only variable
between the reverted-fix and fixed states.

**Verification.** Mutation-tested per the established methodology:
`git stash push -- src/scripts/smart/smartOcfMatcher.js` (pathspec-scoped)
reverted only the fix; rerunning the test then failed both assertions
exactly as predicted (`confidence 75`, `REVIEW_NEEDED`). `git stash pop`
restored the fix; both assertions passed (`confidence 83`, `SAFE`). The
new test file was initially git-untracked, which failed
`tests-js/selfContained.test.mjs`'s `'no new test file is left out of
git'` integrity gate inside `npm run build-verify` — not a functional
failure, but a reminder that new `tests-js/*.test.mjs` files must be
staged by explicit name (`git add <file>`, never `git add -A`) before
running the full gate. After staging both intended files, the complete
gate (`test:node && test:js && test:py && scan-innerhtml --gate &&
scan-rawxml --gate && scan-failopen --gate`) passed cleanly: companion
Python suite 261 passed / 7 skipped, all three security scan gates
(XSS/XXE/fail-open) clean. `git diff --cached --stat` confirmed the
commit scope was exactly the two intended files
(2 files changed, 41 insertions(+), 5 deletions(-)).

**Still open.** All items carried from Iterations 52–57 remain pending
and unchanged. `src/scripts/parsers/fcpxm.js` (no trailing "l") remains
permanently excluded from scouting as confirmed dead code.

Commits: `e94b10a`.

## Iteration 59 — computeReformatParams: centerCrop used the contain scale instead of the cover scale (referenceMatchEngine.js)

**New species.** A 10th distinct bug shape, distinct from all prior iterations:
wrong branch-dependent formula selection. Unlike Iterations 48-50 (fps-base
rounding), 51 (drop-frame misclassification), 52 (windowed-scan position
tracking), 53 (fps-fractional-as-frame-base), 54 (cache identity collision),
55 (TOCTOU race), 56 (match-key normalization gap), 57 (early-return skips
collection), or 58 (partial propagation of a derived value across call
sites), this bug is a case where a boolean/enum branch decision (`fit`) was
computed correctly, but a *second, dependent* value (`scale`) that should
have varied with that same branch was instead computed with a single
hardcoded formula applied to both branches.

**Why this file.** `src/scripts/features/vfxPull/referenceMatchEngine.js`
exports `computeReformatParams(refWidth, refHeight, ocfWidth, ocfHeight,
letterboxInfo)`, used by the VFX Pull "reframe match" feature to compute
how to scale/crop an OCF camera frame onto a reference (QC/master) frame.
Its sibling exports `estimateCDL` and `pickVisualMatch` were left untouched
this iteration (already covered by `tests-js/cdlMatch.test.mjs` and
`tests-js/visualMatch.test.mjs` respectively); `estimateCDL`'s dense
median/patch-filtering SOP+power+saturation solve was flagged by the
scouting agent as an area of residual risk but no concrete bug was found
there.

**The bug.** The function picks a `fit` mode by comparing aspect ratios:
`fit = ocfAR >= refAR ? 'centerCrop' : 'fit'`. `'centerCrop'` means the OCF
is proportionally wider than the reference (e.g. a 2.39:1 anamorphic plate
matched onto a 16:9 reference) and must be scaled up to *cover* the
reference on both axes, cropping the excess on the wider axis. `'fit'`
means the OCF is proportionally narrower/taller and must be scaled down to
*contain* within the reference, letterboxing the shorter axis. These are
opposite scale formulas: cover needs `Math.max(scaleW, scaleH)` (grow until
both axes are at least covered), contain needs `Math.min(scaleW, scaleH)`
(shrink until neither axis overflows). The code computed `scale =
Math.min(scaleW, scaleH)` unconditionally — correct for `'fit'`, wrong for
`'centerCrop'`. For a 2048×858 OCF matched to a 1920×1080 reference: `fit`
correctly resolves to `'centerCrop'` (OCF is wider), but the returned
`scale` was `Math.min(1920/2048, 1080/858) = Math.min(0.9375, 1.2587...) =
0.9375` — the *letterbox* factor — leaving a real gap of `1080 - 0.9375 ×
858 ≈ 275px` uncovered on the vertical axis, exactly the defect a
center-crop is supposed to eliminate. The correct cover factor is
`Math.max(...) ≈ 1.2587`.

Downstream, `computeReformatParams`'s return value is consumed in
`src/scripts/features/vfxPull/vfxPullPanel.js` (~line 5292): `rp.scale`
feeds a `scaleSane` sanity bound (`rp.scale > 0.25 && rp.scale < 8`, ~line
5303) that affects a `confidence` score and can emit a warning (`Unusual
scale ${rp.scale.toFixed(2)} — verify reformat manually.`, ~line 5307), and
is stored directly into the job's reframe geometry (`scale: rp.scale`,
~line 5316). That geometry later surfaces via `reformatScale` fields
(~lines 2484, 4025), a `geometry.scale ?? job.reframe?.scale ?? 1` fallback
(~line 5909), and a UI display (`job.reframe?.scale.toFixed(3)`, ~line
7326) — ultimately feeding the FDL export. The practical effect: any
wider-than-reference OCF (a very common conform scenario — anamorphic or
wide-format camera plates matched to a 16:9 delivery reference) was
reframed with a visible gap on one axis instead of a full-bleed center
crop, while the confidence/warning logic and the "centerCrop" label both
implied a correct, gap-free crop had been computed.

**The fix.** Branch the scale formula on `fit` itself, so it always matches
the semantics the label promises:
```js
const scale = fit === 'centerCrop' ? Math.max(scaleW, scaleH) : Math.min(scaleW, scaleH);
```
placed after `fit` is computed (reordered `scaleW`/`scaleH`/`ocfAR`/`refAR`/
`fit` slightly so `scale` can reference `fit`). No other logic changed —
the aspect-ratio comparison that selects `fit` was already correct.

**Test approach.** New file `tests-js/computeReformatParams.test.mjs`, two
scenarios: (1) a 2048×858 OCF vs. a 1920×1080 reference — asserts `fit ===
'centerCrop'`, asserts `scale` equals `Math.max(scaleW, scaleH)` exactly
(not just "some value"), and independently asserts `scale * ocfHeight >=
refHeight` (the OCF's scaled height actually reaches/exceeds the reference
height — a direct check of the "no letterbox gap" property, not just a
formula-equality check that could pass for the wrong reason); (2) a
1000×1000 OCF vs. the same reference — asserts `fit === 'fit'` and `scale
=== Math.min(scaleW, scaleH)`, confirming the untouched branch still
behaves correctly.

**Verification.** Mutation-tested by `git stash push --
src/scripts/features/vfxPull/referenceMatchEngine.js` (pathspec-scoped, not
a full-tree stash) to revert only the fix, rerunning the test: 2 of 5
assertions failed exactly as predicted — `scale` assertion reported `got
0.9375, expected 1.2587412587412588`, and the height-coverage assertion
failed (the `'fit'`-branch assertions were unaffected, confirming the
mutation only broke the intended branch). `git stash pop` restored the fix;
reran to confirm all 5 assertions passed again. `git status --short`
confirmed no residual changes from the stash cycle. Ran the full `npm run
build-verify` gate after staging the new test file by explicit `git add`
(pre-empting the untracked-test-file gate failure hit in Iteration 58):
clean pass — companion Python suite 261 passed / 7 skipped in 3.11s, `✓ XSS
gate clean`, `✓ XXE gate clean`, `✓ Fail-open gate clean`.

**Still open.** All items carried from Iterations 52–58 remain pending and
unchanged; see prior entries. `src/scripts/parsers/fcpxm.js` (no trailing
"l") remains permanently confirmed dead code, excluded from all future
scouting. Two runner-up leads from this iteration's scouting pass, neither
a confirmed bug, deferred to a future audit: `detectSpeedChange()` in
`src/scripts/modules/conform/audioMatcher.js` (`Math.min(srcFrames -
offsetFrames, srcFrames)` — flagged as likely unreachable with current call
sites, needs a dedicated look at whether a negative `offsetFrames` can ever
occur), and `estimateCDL()` in `referenceMatchEngine.js` (dense
median/patch-filtering SOP+power+saturation solve — no concrete bug found,
but density/complexity make it worth a dedicated audit pass).

Commits: `3e3a941`.

---

## Iteration 60 — ReviewPlayer._sameSource used substring containment as a URL-equality fallback (src/scripts/features/reviews/player.js) — new species

**New species.** An 11th distinct bug shape: a same-source/identity check
used substring containment (`a.includes(b) || b.includes(a)`) as a fallback
for "are these the same resource," which is unsound whenever one string can
be a literal prefix of another distinct string — unlike any prior
iteration's arithmetic, branch-selection, or propagation bugs.

**Why this file.** `src/scripts/features/reviews/player.js`'s
`ReviewPlayer` class drives the Reviews feature's dual-`<video>`-element
"virtual timeline player," swapping an `active`/`standby` pair
(`_swapVideos()`) to make clip-to-clip playback smoother than a single
`<video>` element reloading on every cut. `_sameSource(video, url)` is the
gate used at 7 call sites (`loadAtGlobalTime`, `stepFrames`,
`preloadNext`, `_switchToNextIfNeeded`) to decide "is the requested clip
already loaded in this video element (just seek) or a different one
(reload)."

**The bug.**
```js
_sameSource(video, url) {
  const cur = String(video?.currentSrc || video?.src || '');
  const want = String(url || '');
  if (!cur || !want) return false;
  return cur === want || cur.includes(want) || want.includes(cur);
}
```
The substring-containment fallback falsely reports "same source" whenever
one URL is a literal prefix of the other, even though they identify
genuinely different clips — e.g. `".../stream?clip=clip1"` vs.
`".../stream?clip=clip10"`: `want.includes(cur)` is `true` because `cur`
is exactly the first N characters of `want`. When this fires, the player
skips loading the new clip entirely and seeks within the video element
still showing the *old* clip's frames — wrong footage displayed, with no
error, no reload, and no check that the visible content actually matches
the requested clip.

**The fix.** Replaced the substring fallback with an exact comparison of
resolved absolute URLs:
```js
_sameSource(video, url) {
  const cur = String(video?.currentSrc || video?.src || '');
  const want = String(url || '');
  if (!cur || !want) return false;
  if (cur === want) return true;
  try {
    return new URL(cur, document.baseURI).href === new URL(want, document.baseURI).href;
  } catch {
    return false;
  }
}
```
`new URL(..., document.baseURI)` normalizes relative vs. absolute forms of
the same URL to the same `.href` (so legitimate same-source cases —
`currentSrc` reported as an absolute URL by the browser vs. a relative
`url` argument — still match) while making two distinct URLs that merely
share a prefix compare unequal. All 7 call sites were left untouched since
the method's boolean contract didn't change, only its internal
correctness.

**Test approach.** New file `tests-js/reviewPlayerSameSource.test.mjs`,
using the `linkedom`-based DOM shim pattern already established in
`tests-js/pfxTransportDom.test.mjs` (`parseHTML` → `globalThis.document`).
Since `linkedom`'s `document.baseURI` is `null` with no document URL,
the test explicitly defines it (`Object.defineProperty(document,
'baseURI', ...)`) so the code under test has a real base to resolve
relative URLs against. 9 assertions: (1)-(2) `clip=clip1` vs. `clip=clip10`
in both directions — the exact "one URL is a literal prefix of the other"
shape the old code got wrong — must return `false`; (3) identical absolute
URLs must return `true`; (4) a relative URL that resolves to the same
absolute URL as `currentSrc` must return `true` (confirms the `new
URL(...)` normalization doesn't break legitimate same-source detection);
(5)-(9) empty/null/undefined `url`, empty `currentSrc`, and a `null` video
must all return `false` (existing early-return behavior preserved).

Note: an earlier draft of this test used `".../clip1.mp4"` vs.
`".../clip12.mp4"` as the false-positive example — but that pair does
*not* actually trigger the old substring bug, because the differing file
extensions break the containment relationship (`"clip1.mp4"` is not a
substring of `"clip12.mp4"`). The real bug needs a true prefix
relationship end-to-end, which query-string clip ids without a
disambiguating suffix (`clip=clip1` vs. `clip=clip10`) provide.

**Verification.** Mutation-tested via `git stash push --
src/scripts/features/reviews/player.js` (pathspec-scoped): with the fix
reverted, exactly the 2 prefix-containment assertions failed (7 of 9
passed — the other assertions were unaffected, confirming the mutation
only broke the intended cases). `git stash pop` restored the fix; reran
to confirm all 9 assertions passed. Staged the new test file by explicit
`git add` before running `npm run build-verify` (per the Iteration 58
lesson): clean pass — companion Python suite 261 passed / 7 skipped, `✓
XSS gate clean`, `✓ XXE gate clean`, `✓ Fail-open gate clean`. Confirmed
`git diff -- src/scripts/features/reviews/player.js` showed only the
intended `_sameSource` change (the file was verified byte-identical to
`HEAD` before this session's edit, per the new pre-selection practice
below).

**Lesson learned — new pre-selection practice.** This iteration's
original scouting target (a fps/fpsExact timecode-base confusion in
`src/scripts/features/trlconf/index.js`) was found, fixed, and verified,
but ultimately **abandoned and fully reverted**: the file turned out to be
entangled in ~1500 lines of pre-existing uncommitted work-in-progress not
present in `HEAD` at all (`git show HEAD:... | wc -l` was ~1400 lines
shorter, and the surrounding functions didn't exist in `HEAD`), making any
fix there impossible to isolate into a clean, scoped commit. Investigating
this also surfaced that the working tree's pre-existing dirty-vs-`HEAD`
condition is far larger than previously assumed — roughly 400+ files
across nearly the entire repository, not a small set of known "noise"
files. **New practice for all future iterations:** before investing any
effort into a candidate fix, first run `git diff --stat -- <file>` against
`HEAD` and confirm it is empty; reject any file that is already dirty as a
target, regardless of bug quality, since a fix there can never be
committed in isolation.

Commits: `5d4e82a`.

## Iteration 61 — Canon C-Log2 footage silently misclassified as C-Log3 in ocfIdtResolver.js — new species

**Why this file.** `src/scripts/features/aceslook/services/ocfIdtResolver.js`
bridges OCF probe metadata to the ACES IDT (Input Device Transform) auto-detection
used by both ACES Look and VFX Pull's color-plan/AMF/FDL generation. It was
confirmed **untracked** (not present in `HEAD` at all — `git diff --stat`
against `HEAD` was trivially empty because there was no `HEAD` version to diff
against, not because the file was "clean" in the usual sense). This is a
narrower but real variant of the "clean-candidate" check: a brand-new,
never-committed file has no HEAD entanglement risk, so a fix (and the file
itself) could be added in one clean, scoped commit.

**The bug.** `_findBySearchStr(searchStr)` iterates `IDT_MAP` in array order
and returns the *first* entry whose `match` array contains a token found in
`searchStr` (a lowercased concatenation of `colorSpace + codec + cameraType +
cameraFamily + format + container`). The Canon C-Log3 entry's match list was
`['clog3', 'c-log3', 'cinema gamut', 'canon']` — including the bare vendor
token `'canon'` — and it appeared in `IDT_MAP` *before* the Canon C-Log2 entry
(`['clog2', 'c-log2']`). Any OCF metadata carrying `cameraFamily: 'Canon'` (or
a `cameraType` string containing "Canon") matches the generic `'canon'` token
on the earlier C-Log3 entry, short-circuiting the search before the more
specific `'clog2'`/`'c-log2'` tokens are ever checked.

Concrete failure:
```js
resolveIdtFromOCFMeta({ colorSpace: 'C-Log2', cameraFamily: 'Canon', codec: 'XF-AVC' })
```
`searchStr` = `"c-log2 xf-avc  canon "`. This contains both `'c-log2'` (which
should hit the C-Log2 entry) and `'canon'` (which hits the earlier C-Log3
entry). `_findBySearchStr` returns the **C-Log3** IDT
(`IDT.Canon.CLog3_CGamut.a1.v1`, label "Canon C-Log3 / Cinema Gamut") instead
of the correct C-Log2 IDT. The same generic token also swallows plain
non-log Canon footage (e.g. `cameraType: 'Canon EOS R5 C', colorSpace:
'Rec.709', codec: 'H.264'`), misclassifying it as ACES log footage instead of
falling through to the Rec.709 fallback entry.

**Why this is a genuine correctness bug.** The wrong IDT means the wrong
log-curve/gamut decode transform gets applied to the footage — a silent,
incorrect color-science result. `isAutoDetected: true` is still set on the
mismatched result, so nothing flags it to the user as a guess or fallback.
Canon C-Log2 is a common profile (e.g. C300 Mark III workflows); any such
shoot was silently transformed as if it were C-Log3.

**The fix.** Removed the bare `'canon'` token from the C-Log3 entry's `match`
array, leaving only log-profile-specific markers (`['clog3', 'c-log3',
'cinema gamut']`). Cameras that are Canon but don't hit `clog2`/`clog3`
correctly fall through to the existing Rec.709 fallback entry later in
`IDT_MAP`, which already handles "Canon but unknown log profile" without a
false-positive short-circuit. A comment was added directly above the Canon
section explaining why a bare vendor token must never be added to a
match array ahead of more specific tokens for the same vendor.

**Test approach.** `tests-js/ocfIdtResolverCanonLog.test.mjs` — plain Node,
no DOM/linkedom shim needed (the module has no browser dependencies). Three
assertions: (1) Canon C-Log2 metadata resolves to the C-Log2 IDT (was
resolving to C-Log3 before the fix — this is the actual bug), (2) Canon
C-Log3 metadata still resolves to the C-Log3 IDT (regression guard on the
still-valid case), (3) plain non-log Canon Rec.709 footage still resolves to
the Rec.709 fallback rather than being swept up by a vendor-token match.

**Verification (mutation testing).** Since the target file was untracked
(not in `HEAD`), the usual pathspec-scoped `git stash push -- <file>`
mutation-testing technique doesn't apply to it (stash requires a tracked
diff to stash by default). Instead, mutated via a plain file copy: saved the
fixed file to `/tmp`, reintroduced the bare `'canon'` token, ran the test
(1 of 3 passed — the two bug-triggering assertions failed exactly as
expected), then restored the fixed file from the `/tmp` copy and reran (3 of
3 passed). No git state was touched during this mutation cycle.

**Gate.** `npm run build-verify` initially failed on an unrelated-looking but
directly-caused check: `tests-js/selfContained.test.mjs`'s "the baselines do
not outlive what they describe" test failed, because
`tests-js/fixtures/untracked-imports.json` is a debt allowlist of
tracked-file-imports-an-untracked-file pairs that must only ever shrink, and
adding `ocfIdtResolver.js` to git retired 3 of its entries
(`amfBuilder.js`, `colorPlanEngine.js`, `fdlGenerator.js` → `ocfIdtResolver.js`)
that were now stale. Removed exactly those 3 lines from the baseline
(confirmed via `git show HEAD:tests-js/fixtures/untracked-imports.json` diff
that no other lines were touched) and reran the gate: clean pass — companion
Python suite 261 passed / 7 skipped, `✓ XSS gate clean`, `✓ XXE gate clean`,
`✓ Fail-open gate clean`.

**Still open.** None for this fix. `IDT_MAP` should probably be audited for
other vendor sections with a similar bare-vendor-token-before-specific-token
ordering risk (RED, Sony, Blackmagic, DJI sections all list a bare vendor
name in at least one entry's match array), but none of those currently sit
*before* a more specific same-vendor entry the way Canon's did, so no
further fix was made this iteration.

Commits: `26f460d`.

## Iteration 62 — mediaSearchBox debounce race lets a slower earlier search clobber a faster later one — new species

**Why this file.** `src/scripts/features/mediaSearch/mediaSearchBox.js` mounts
a debounced media-library search box (query via `db.search` over the native
engine IPC bridge) used from the VFX Pull panel and IMF UI. Confirmed
**untracked** (`git status --porcelain` showed `??`, no `HEAD` entry to diff
against), matching the same "brand-new file, no HEAD entanglement" category
as Iteration 61's target.

**The bug.** The input handler debounced searches with `clearTimeout` +
`setTimeout`:
```js
let timer = null;
input.addEventListener('input', () => {
  const term = input.value.trim();
  clearTimeout(timer);
  if (!term) { render({ rows: [] }, ''); return; }
  timer = setTimeout(async () => { render(await _search(term), term); }, 200);
});
```
`clearTimeout(timer)` only cancels a timer that has not fired yet. Once the
200ms debounce elapses and `_search(term)` starts (an async IPC round-trip
with variable, unbounded latency), a later keystroke's debounce firing
starts a *second*, independent `_search()` call — there is no cancellation
or sequencing between the two in-flight calls. `render()` unconditionally
overwrites `results.innerHTML` and the closure variable `lastRows` with
whatever response arrives, regardless of arrival order.

Concrete failure: type "cat" and pause — debounce fires, `_search("cat")`
starts against a slow query. Before it resolves, type "s" (→ "cats") and
pause again — a second debounce fires, `_search("cats")` starts and resolves
quickly, correctly rendering the "cats" results. Then the earlier, slower
"cat" response arrives and its `render(catState, "cat")` call silently
overwrites the dropdown and `lastRows` with the "cat" result set, even
though the input box still shows "cats". If the user then clicks the top
visible row, `results.addEventListener('mousedown', ...)` reads
`lastRows[Number(item.dataset.i)]` — now indexing into the stale "cat"
array — so `onPick(rec)` fires with a media record that does not match what
was visually selected. In VFX Pull this means the wrong media file can be
silently linked to a shot.

**Why this is a genuine correctness bug, and a new species.** None of
Iterations 48-61 involve out-of-order resolution of two independently-fired
async operations racing to write shared UI state ("last write wins" on a
stale response). The closest prior bugs — 55 (cross-tab leader-election
TOCTOU) and 52 (windowed-scan position tracking) — are structurally
different: 55 is a race over which of several *tabs* claims leadership, not
over which of several *sequential requests from the same UI element*
resolves last; 52 is a scan-position bookkeeping bug, not an async
supersession bug. This is a debounced-UI-search race, a new species.

**The fix.** Added a monotonic sequence counter incremented on every input
event; captured the counter's value (`mySeq`) at debounce-schedule time and
compared it against the live counter (`seq`) after the search resolves,
skipping `render()` if a newer keystroke has since superseded it:
```js
let seq = 0;
input.addEventListener('input', () => {
  const term = input.value.trim();
  const mySeq = ++seq;
  clearTimeout(timer);
  if (!term) { render({ rows: [] }, ''); return; }
  timer = setTimeout(async () => {
    const state = await _search(term);
    if (mySeq !== seq) return;
    render(state, term);
  }, 200);
});
```

**Test approach.** `tests-js/mediaSearchBoxRace.test.mjs` — linkedom DOM
harness (mirroring `pfxTransportDom.test.mjs`'s pattern). Mocks
`window.pfxPlatform.nativeEngine.command` with a controllable-resolution
fake so the test can deterministically resolve a slower "cat" search after
a faster "cats" search, then asserts the dropdown reflects "cats", not the
stale "cat" response.

**Verification (mutation testing).** File is untracked, so used the same
plain file-copy backup/restore technique as Iteration 61 (git stash pathspec
doesn't apply to untracked files): saved the fixed file, reintroduced the
un-sequenced debounce logic via a scripted edit, ran the test (1 of 1
failed, exactly reproducing the race), restored the fix, reran (1 of 1
passed).

**Gate.** `npm run build-verify` first failed on
`tests-js/selfContained.test.mjs`'s baseline-shrink check again — tracking
`mediaSearchBox.js` retired 2 stale `tests-js/fixtures/untracked-imports.json`
entries (`vfxPullPanel.js` and `imf_ui.js` importing it). Removed exactly
those 2 lines (diffed against `HEAD` to confirm nothing else changed) and
reran: clean pass (Python suite 261 passed / 7 skipped, XSS/XXE/fail-open
gates clean).

**Still open.** None for this fix.

Commits: `7be729e`.

## Iteration 63 — GPU SDR-passthrough shader clips negative signed samples instead of wrapping them — new species

**Why this file.** `src/scripts/modules/imf/imf_gl_present.js` implements
"Path B" of the IMF viewer's frame present pipeline — a WebGL2 fragment
shader that ports the CPU reference color pipeline in
`imf_render_worker.js` to the GPU for faster playback. Confirmed
**untracked** (`git status --porcelain` showed `??`, no `HEAD` entry to diff
against).

**The bug.** The CPU reference's SDR-passthrough path (`px()`,
`imf_render_worker.js:237-242`) is:
```js
const shift = bitsPerSample > 8 ? Math.max(0, bitsPerSample - 8) : 0;
const px = (v) => {
  const n = bitsPerSample > 8 ? (v >> shift) : v;
  return Math.max(0, Math.min(255, n & 0xff));
};
```
`n & 0xff` performs two's-complement modulo-256 wraparound — it is defined
for negative `n` (JS's `>>` and `&` operate on 32-bit two's-complement
integers, so this correctly extracts the low byte regardless of sign). The
GPU port (`u_colorMode == 0` branch) re-implemented this in GLSL floating-
point arithmetic as:
```glsl
vec3 c = clamp(floor(s / u_sdrDiv), 0.0, 255.0) / 255.0;
```
`floor(s / u_sdrDiv)` correctly replicates `v >> shift` (both are
sign-preserving floor-division by a power of two), but `clamp(...,
0.0, 255.0)` does **not** replicate `& 0xff`: clamp *clips* out-of-range
values to the nearest bound, while `& 0xff` *wraps* them modulo 256. For
any negative shifted sample, `clamp` collapses it to 0 instead of wrapping
it into the correct low byte.

This is reachable in practice: `_colorMode(colorInfo)`
(`imf_gl_present.js:99-105`) selects mode 0 purely from
`!_isPQTransfer(colorInfo.transfer)`, independent of whether the source
samples are signed. A 12-bit signed (`i16`/`isampler2D`) IMF source with
`transfer` not PQ reaches mode 0 with genuinely negative sample values.
Concrete failure: 12-bit signed sample `v = -100` — CPU `px(-100)` = 249
(correct low-byte wraparound); GPU `clamp(floor(-100/16), 0, 255) =
clamp(-7, 0, 255) = 0` (wrong — clipped to black instead of the correct
byte value).

**Why this is a genuine correctness bug, and a new species.** None of
Iterations 48-62 involve integer bit-pattern/two's-complement semantics
being lost when a CPU integer routine is re-implemented in floating-point
GPU shader math. The closest prior bugs — 53 (fps-fractional-as-frame-base)
and 59 (wrong branch-dependent formula selection) — are arithmetic-formula
bugs, not a representation-semantics mismatch between an integer bitwise
operation and its floating-point shader analog. This is a
CPU-integer-op-ported-to-float-shader-op species: clamp used where wrapping
(mod) was required.

**The fix.** Replaced `clamp(...,0.0,255.0)` with `mod(...,256.0)`. GLSL's
`mod(x,y)` is floor-based (`mod(x,y) = x - y*floor(x/y)`), which reproduces
two's-complement truncation (`& 0xff`) for any integer, positive or
negative, and is a no-op for the already-valid unsigned case (no regression
risk):
```glsl
if (u_colorMode == 0) {
  // SDR passthrough — matches px(): (v >> (bits-8)) & 0xff, then /255.
  // clamp() would clip negative signed samples to 0 instead of wrapping
  // them into the low byte the way & 0xff does, so use mod() (GLSL's
  // mod is floor-based, so it matches two's-complement truncation for
  // any integer, positive or negative).
  vec3 c = mod(floor(s / u_sdrDiv), 256.0) / 255.0;
  fragColor = vec4(c, 1.0);
  return;
}
```

**Test approach.** This repo has no WebGL/`headless-gl` test harness, so
following the established source-string-content test pattern (as in
`authConfigInherit.test.mjs`, `domContract.test.mjs`, etc.), the new
`tests-js/imfGlPresentSdrPassthrough.test.mjs` extracts the actual shipped
GLSL expression from the fragment shader source string via regex, then
evaluates it numerically in JS using a tiny GLSL-arithmetic-to-JS
translator (`floor`, `clamp`, `mod` — with `glslMod` implementing GLSL's
floor-based `mod`), and compares the result against the CPU reference
(`px()`, reimplemented directly with `>>`/`&`) for representative inputs:
8-bit unsigned, 16-bit unsigned byte-aligned, and two negative signed cases
(12-bit and 16-bit). Because the test parses the real shipped GLSL string
rather than a hand-duplicated formula, it can't drift from what actually
ships.

**Verification (mutation testing).** File is untracked, so used the plain
file-copy backup/restore technique (git stash pathspec doesn't apply to
untracked files): backed up the fixed file, scripted-reverted the `mod`
line back to the buggy `clamp` line in place, ran the test — 2 passed / 2
failed (exactly the two negative-signed-sample cases, `got 0` instead of
249/138), exit code 1. Restored the fix, reran — 4 passed / 0 failed.

**Gate.** `npm run build-verify` failed twice before passing clean:
1. `tests-js/selfContained.test.mjs`'s "no new test file is left out of
   git" check — the new test file was untracked/unstaged. Fixed by staging
   both the source and test file by explicit name.
2. `tests-js/selfContained.test.mjs`'s baseline-shrink check — tracking
   `imf_gl_present.js` for the first time retired 1 stale
   `tests-js/fixtures/untracked-imports.json` entry
   (`imf_player.js -> imf_gl_present.js`). Removed exactly that line
   (diffed against `HEAD` to confirm nothing else changed).

Reran: clean pass (Python suite 261 passed / 7 skipped, XSS/XXE/fail-open
gates clean).

**Still open.** None for this fix.

## Iteration 64 — XMEML normalize step silently deleted legitimate frame-0 clips — new species

**Why this file.** `src/scripts/parsers/xml.js` (the XMEML/FCP7 parser) surfaced
from a scouting pass over the parser layer. Unlike Iterations 61-63's
targets, it was already tracked and clean before this iteration
(`git status --porcelain` and `git diff --stat` both empty for it), so this
is the first of the last four iterations where the fix did not touch a
brand-new file.

**The bug.** After building `events` from the XML, `parseXMEML()` runs a
post-parse "normalize" pass (comment, in Thai, translates to "trim events
where srcIn == 00:00:00:00 if the same srcFile has both 00:00:00:00 and a
non-zero value"). It grouped events by `srcFile`/`reel`/`clipName`, and if a
group contained ANY event with a non-zero `srcIn`, it dropped every event in
that group whose `srcIn` was literally `"00:00:00:00"` — treating a zero
in-point as a placeholder/stub left behind by some other bug, rather than
what it actually is: a completely ordinary edit that happens to cut in from
the very first frame of its source media.

Concrete failure: two clips on the timeline both reference the same camera
master `A001C001.mov` (a common real-world pattern — reusing one take across
multiple cuts). The first clip cuts in from frame 0 of the media
(`srcIn = "00:00:00:00"`); the second cuts in later
(`srcIn = "00:00:09:15"`). Because the second clip's non-zero `srcIn` shares
the group key with the first, the normalize step silently deleted the
first clip from the parser's output entirely — no error, no warning, and
since `id` is re-assigned after this step, not even detectable as a gap in
the numbering.

**Why this is a genuine, new species.** Traced history with
`git log -p --follow -- src/scripts/parsers/xml.js | grep <the Thai comment
text>` — the block predates every diff-visible commit, meaning it has been
present since the very first commit in the repo's history with no
recoverable rationale for why a zero srcIn was ever treated as suspect. No
test in `test/parsers/xml.test.mjs` covered this path before this fix. It
is structurally distinct from every one of species 48-63: not a
rounding/rate bug (48-50, 53), not drop-frame misclassification (51), not a
windowed-scan tracking bug (52), not an identity-collision or race (54, 55,
62), not a normalization/match-key gap of the kind fixed in 56 (that one was
about failing to normalize equivalent keys; this one over-normalizes,
conflating two semantically different values — a real zero and an assumed
stub — that happen to share a string representation), not an early-return
(57), not partial-propagation (58), not wrong-branch-selection (59), not a
substring/URL-equality issue (60), not an array short-circuit (61), not a
CPU-vs-shader representation mismatch (63). The failure mode here is a
dedup/normalize heuristic that conflates a legitimate zero-value field with
a placeholder sentinel, silently discarding a real, distinct timeline event
purely because an unrelated sibling event in the same grouping key has a
non-zero value in that field.

**The fix.** A scouting pass had proposed either adding a positive
"resolver-fallback" flag to mark genuinely-unresolved rows (would require
new plumbing through the whole parse path with no existing signal to hang
it on) or removing the dedup step outright (would also drop whatever
legitimate duplicate-artifact protection it may have offered). Chose a
third, more conservative fix: restrict the drop to true literal duplicates
— an event is only dropped for having `srcIn === "00:00:00:00"` if another
event in the exact same group also matches its `recIn`, `recOut`, and
`srcOut`. That is the only condition under which two rows in the same group
could actually be redundant parses of the same edit; a zero srcIn is never
by itself evidence of anything.

```js
// normalize: drop literal duplicate rows within the same source — same
// record range AND same source out, differing only by a stray zero srcIn.
// srcIn == "00:00:00:00" is NOT itself a signal of a bogus/unresolved row:
// it is a perfectly ordinary in-point for a clip cut in from the first
// frame of its media, so it must never be dropped just for being zero.
const ZERO_TC = "00:00:00:00";
const bySrc = new Map();

for (const ev of events) {
  const key = ev.srcFile || ev.reel || ev.clipName || "";
  if (!bySrc.has(key)) bySrc.set(key, []);
  bySrc.get(key).push(ev);
}

const normalizedEvents = [];
for (const [, group] of bySrc.entries()) {
  for (const ev of group) {
    const isDuplicateStub = ev.srcIn === ZERO_TC && group.some(other =>
      other !== ev && other.srcIn !== ZERO_TC &&
      other.recIn === ev.recIn && other.recOut === ev.recOut && other.srcOut === ev.srcOut
    );
    if (!isDuplicateStub) normalizedEvents.push(ev);
  }
}
```

Confirmed by reading the surrounding code (lines ~1248-1293) that
`normalizedEvents` is subsequently sorted, re-indexed, and returned directly
as `result.events` — nothing else consumes the pre-normalize `events`
array, so this in-place block replacement is complete and safe.

**Test approach.** The existing `xmeml_basic.xml` fixture could not
reproduce the bug: its two clips reference different `srcFile` names, and
its file-level `<timecode><frame>90000</frame>` means `srcIn` is never
literally `"00:00:00:00"` even for a clip with `<in>0</in>` (the computed
`srcInTC` folds in the file-level timecode start). So, following the
precedent of the "every broadcast rate splits into a whole base and an
exact rate" test (which also builds XML programmatically), added a new test
to `test/parsers/xml.test.mjs` with an inline XML string using
`<timecode><frame>0</frame>` at the file level and two clips sharing one
`srcFile`, one with `<in>0</in>` and one with `<in>240</in>`, and asserted
both clips survive with the correct `srcIn` values.

**Verification (mutation testing).** File was tracked-and-clean before this
edit; used the plain file-copy backup/restore technique (kept for
consistency with prior iterations, though `git stash` on this pathspec
would also have worked since nothing was untracked here). Reverted the fix
back to the original grouped-drop logic via a guarded string replacement:
new test failed as expected (`AssertionError: both clips survive (was 1:
the frame-0 clip vanished)`, `1 !== 2`). Restored the fix: full suite green,
6/6 in `test/parsers/xml.test.mjs`.

**Gate.** `npm run build-verify` passed clean (exit 0) on the first
attempt — no `untracked-imports.json` baseline issue this time, because
both `src/scripts/parsers/xml.js` and `test/parsers/xml.test.mjs` were
already tracked files before this iteration began, unlike Iterations
61-63's untracked targets. Grepped the full log for failure markers
(`FAIL -|Error:|not ok|AssertionError|Cannot find module|SyntaxError|TypeError`)
and confirmed the few hits were false positives inside passing tests'
names/messages, not genuine failures.

**Still open.** None for this fix.

Commits: `325445a`.

## Iteration 65 — companion HTTP server mis-served suffix byte-ranges — new species

**Why this file.** `companion/src/postflowx_companion/http_server.py` is the
Python companion's request handler for `/stream/`, `/file/`, and `/wav/`
asset serving. It surfaced from a scouting pass explicitly directed away
from the timecode/editorial parser layer (all of species 48-64) toward
other mechanisms — HTTP request handling in the companion server. Before
this fix, `git status --porcelain` showed the file as modified, but
`git diff` showed the change was a bare file-mode flip (`100644 → 100755`,
0 content lines) — the range-parsing code itself was unmodified from the
repo's sole initial commit.

**The bug.** `_serve_file()`'s `Range` header parsing (lines 758-764,
before this fix):

```python
range_hdr = self.headers.get("Range", "")
if range_hdr.startswith("bytes="):
    start_s, _, end_s = range_hdr[6:].partition("-")
    start = int(start_s) if start_s else 0
    end = int(end_s) if end_s else size - 1
    end = min(end, size - 1)
```

Per RFC 7233 §2.1, `Range: bytes=-N` is a *suffix* range meaning "the last N
bytes of the resource" — there is no start value at all, not an omitted end
value. But `"-500".partition("-")` (splitting on the first `-`, which is
the very first character) yields `("", "-", "500")`: `start_s` is empty, so
the `else 0` branch fires and `start` becomes `0` instead of `size - 500`.

Concrete failure: a 50,000,000-byte file, request `Range: bytes=-500`.
`start_s = ""`, `end_s = "500"` → `start = 0`, `end = 500`. The
inverted/unsatisfiable-range guard (`start < 0 or start > end or start >=
size`) passes cleanly (0 ≤ 500 < size), so the server responds `206
Partial Content` with `Content-Range: bytes 0-500/50000000` and streams the
**first** 501 bytes — not the requested last 500. This is exactly the
pattern used by media tooling/clients to fetch a trailing chunk to locate a
non-fast-start MP4/MOV's trailing `moov` atom (common for ffmpeg output not
remuxed with `-movflags +faststart`), so any such client talking to this
companion's streaming endpoints gets silently wrong bytes back with a
success status and a `Content-Range` header that mislabels them.

**Why this is a genuine, new species.** None of species 48-64 touch HTTP
request/response handling at all — they are timecode/fps arithmetic,
parser data-model bugs, cache/identity/race conditions, or a GLSL/CPU
integer-representation mismatch. This is a string-parsing bug in an
RFC 7233 header parser: `str.partition("-")` on a leading-hyphen string
silently produces an empty "before" component that gets treated as "value
omitted" rather than "this is the suffix form," a failure mode with no
resemblance to any of 48-64 (not a rounding error, not an identity
collision, not a race, not a normalize/dedup conflation, not an
integer-representation mismatch — it's a header-grammar
under-specification: two structurally different range forms that happen to
produce the same `partition()` shape when the omitted piece is the start
rather than the end).

**The fix.** Added a branch that explicitly detects the suffix-range form
(`start_s` empty AND `end_s` non-empty) and computes `start = size -
suffix_length` (clamped to 0), leaving the ordinary `bytes=N-`, `bytes=N-M`,
and malformed-header paths untouched:

```python
if range_hdr.startswith("bytes="):
    start_s, _, end_s = range_hdr[6:].partition("-")
    if not start_s and end_s:
        # Suffix range "bytes=-N": the last N bytes of the resource,
        # per RFC 7233 §2.1 — not "start omitted, so start at 0".
        start = max(0, size - int(end_s))
        end = size - 1
    else:
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    end = min(end, size - 1)
```

Safe because `_serve_file()` is the only place in the companion that reads
or interprets the `Range` header, and every other branch (full requests,
`bytes=N-`, `bytes=N-M`, unsatisfiable ranges → 416) is untouched by this
change.

**Test approach.** Added `test_suffix_range_serves_last_n_bytes` to the
existing `TestServeFileRange` class in `companion/tests/test_http_server.py`
(following its established `_make_handler` + mocked
`send_response`/`send_header`/`wfile` pattern), asserting on a 10-byte file
with `Range: bytes=-4` that the response is `206`, `Content-Range: bytes
6-9/10`, and the actual bytes written to `wfile` are `b"6789"` — not just
the header, so a fix that gets the header right but the seek/read wrong
would still fail.

**Verification (mutation testing).** File was tracked; used the plain
file-copy backup/restore technique. Reverted the fix back to the original
unconditional `start = int(start_s) if start_s else 0` via a guarded Python
string-replacement script and reran: new test failed
(`AssertionError: assert ['bytes 0-4/10'] == ['bytes 6-9/10']`), the other
22 pre-existing tests in the file still passed. Restored the fix: all 23
tests in `companion/tests/test_http_server.py` passed.

**Gate.** `npm run build-verify` passed clean (exit 0) on the first
attempt — both target files were already tracked, so no
`untracked-imports.json` baseline issue. Full Python suite: 262 passed, 7
skipped. Grepped the full log for failure markers and confirmed all hits
were false positives inside passing tests' names/messages (e.g. a test
asserting an error-classifier's output for a message containing the
literal string "SyntaxError").

**Still open.** None for this fix.

Commits: `621a708`.

## Iteration 66 — companion drop-frame timecode only changed the separator, not the frame count — new species

**Why this file.** `companion/src/postflowx_companion/proxy_service.py`
already carries the fix for species 51 (23.976 wrongly classified as
drop-frame). A scouting pass over the same drop-frame code path, focused
on areas not yet covered by species 48-65, found that the *classification*
fix from species 51 was correct but the *arithmetic* right next to it had
never implemented SMPTE drop-frame compensation at all.

**The bug.** `_seconds_to_timecode()` (lines 2421-2434, before this fix):

```python
def _seconds_to_timecode(seconds: float, fps: float, drop_frame: bool = False) -> str:
    """Convert a duration in seconds to HH:MM:SS:FF (or HH:MM:SS;FF for DF)."""
    fps_base = _fps_to_base(fps)
    if fps_base <= 0:
        fps_base = 24
    total_frames = int(round(max(0.0, seconds) * fps))
    h = total_frames // (fps_base * 3600)
    remaining = total_frames - h * fps_base * 3600
    m = remaining // (fps_base * 60)
    remaining -= m * fps_base * 60
    s = remaining // fps_base
    f = remaining % fps_base
    sep = ';' if drop_frame else ':'
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{f:02d}"
```

`drop_frame` is used only to pick `;` vs `:` — the frame-number arithmetic
above it is plain non-drop division regardless. SMPTE drop-frame timecode
for 29.97/59.94 must additionally skip frame *labels* 00/01 (or 00-03 at
59.94) at the start of every minute except every 10th, so that the
displayed timecode tracks wall-clock time. This codebase already has a
correct implementation of that algorithm in
`src/scripts/modules/utils_time.js` (`_dfFramesToTC`), so the Python side
silently diverges from the JS side for the same input.

**Concrete failure example.** `_seconds_to_timecode(60.06, 29.97, True)` —
a 29.97fps drop-frame clip, one minute and two frames in — computed
`total_frames = round(60.06 * 29.97) = 1800` and returned `"00:01:00;00"`.
The correct SMPTE drop-frame label for that instant is `"00:01:00;02"`
(frames 00 and 01 are skipped labels at the top of a non-tenth minute).
The error is as large as 18 frames (~0.6s) near a 10-minute boundary. This
is reached whenever a 29.97/59.94fps clip has an embedded drop-frame
QuickTime timecode track — `proxy_service.py` sets `out['dropFrame'] = ';'
in out['startTimecode']` and then calls this function to build
`out['durationTimecode']`, which flows into `api.py`'s OCF preview/seek
and batch-pick paths (lines 143, 3174, 3231) and the renderer's TC
display.

**Why genuine and new.** Species 51 was a *classification* bug — deciding
whether a rate should use drop-frame formatting at all. This bug is
different in kind: the rate is correctly identified as drop-frame, but the
frame-number math needed to actually produce a correct drop-frame label
was never implemented — only the cosmetic separator changed. It is
unrelated to fps-base rounding, cache identity, races, key normalization,
propagation, branch selection, containment matching, short-circuit
ordering, async staleness, shader integer/float semantics, sentinel
conflation, or HTTP range parsing (species 48-65). The existing regression
suite for species 51
(`companion/tests/test_drop_frame_rate.py`) only asserted separator
presence/absence for the non-drop 23.976 case — it never asserted a
correct frame *number* for a true drop-frame timecode, so this bug had
zero coverage.

**The fix.** Convert the real elapsed frame count into the equivalent
nominal-fps labeled count (the standard drop-frame compensation formula)
before doing the division, only when `drop_frame` is set and the rate is
one of the two that has a drop-frame form:

```python
    total_frames = int(round(max(0.0, seconds) * fps))
    if drop_frame and fps_base in (30, 60):
        # SMPTE drop-frame: 29.97/59.94 skip frame *labels* (not real frames) so
        # the displayed TC tracks wall-clock time. Convert the real elapsed frame
        # count into the equivalent nominal-fps labeled count before dividing.
        drop_count = 2 if fps_base == 30 else 4
        frames_per_min = fps_base * 60 - drop_count
        frames_per_10min = frames_per_min * 10 + drop_count
        d, m = divmod(total_frames, frames_per_10min)
        if m >= drop_count:
            total_frames += drop_count * (9 * d + (m - drop_count) // frames_per_min)
        else:
            total_frames += drop_count * 9 * d
    h = total_frames // (fps_base * 3600)
```

This is the canonical drop-frame algorithm (same shape as the codebase's
own `_dfFramesToTC` in `utils_time.js`, verified by hand against it before
implementing). Safe because it only executes inside the new
`drop_frame and fps_base in (30, 60)` branch — the non-drop path used by
every other rate, and by drop_frame=False calls at 29.97/59.94, is
untouched.

**Test approach.** Added three tests to the existing
`companion/tests/test_drop_frame_rate.py`: one asserting the one-minute
skip at 29.97 (`60.06s → "00:01:00;02"`), one asserting no skip at a
10-minute boundary (`600.0s → "00:10:00;00"`), and one asserting the
four-frame skip at 59.94 (`60.06s → "00:01:00;04"`). Values were derived
by hand from the drop-frame algorithm and cross-checked by running the
actual function before trusting them (an early draft of the 10-minute-
boundary test used the wrong `seconds` value and had to be corrected after
seeing its actual output).

**Verification (mutation testing).** File was tracked and clean. Used the
plain file-copy backup/restore technique: disabled the new branch via
`if False and drop_frame and ...`, reran — all three new tests failed with
the expected wrong values (`'00:01:00;00' == '00:01:00;02'`,
`'00:09:59;12' == '00:10:00;00'`, `'00:01:00;00' == '00:01:00;04'`), the 4
pre-existing tests in the file still passed. Restored the fix: all 7 tests
in `test_drop_frame_rate.py` passed.

**Gate.** `npm run build-verify` passed clean (exit 0) on the first
attempt — both target files were already tracked, so no
`untracked-imports.json` baseline issue. Full Python suite: 265 passed
(262 + 3 new), 7 skipped. Grepped the full log for failure markers and
confirmed all hits were false positives inside passing tests' names or
messages (error-classifier tests whose input literally contains
"SyntaxError", and an OTIO-parse-failure test literally named/asserting
"SyntaxError" as expected content).

**Still open.** None for this fix.

Commits: `2823c48`.

Commits: `50e0be7`.

## Iteration 67 — MXF MIC verification aggregated the whole file instead of scoping per-partition — new species

**Why this file.** `companion/src/postflowx_companion/imf_mic.py` implements
`verify_mxf_mic()`, which recomputes an SMPTE ST 429-6 "message integrity
code" (MIC) digest over an MXF track file's essence-container elements and
compares it against the embedded `EssenceIntegrityPack` KLV. The module's own
docstring describes this as a *per-partition* mechanism — SMPTE defines the
integrity pack as covering the essence written in its own partition, and a
real multi-partition MXF/IMF track file can carry one integrity pack per body
partition.

**The bug.** The KLV-walking loop in `verify_mxf_mic()` had no
partition-boundary or per-pack scoping at all:

```python
essence_elements: list[KlvTriplet] = []
integrity_value: bytes | None = None

for kl in iter_klv(f):
    if is_essence_element(kl.key):
        essence_elements.append(kl)
    elif is_integrity_pack(kl.key):
        cur = f.tell()
        f.seek(kl.value_offset)
        integrity_value = f.read(kl.length)
        f.seek(cur)
```

Every essence element in the entire file — across every partition — was
appended to one flat list, and `integrity_value` was unconditionally
overwritten on each `is_integrity_pack` match, so only the *last* pack found
survived. The single whole-file digest was then compared only against that
last pack, silently discarding every earlier one.

**Concrete failure example.** For a two-partition file (partition A's
essence + pack A, partition B's essence + pack B): a bit flip in partition
A's essence does not change the digest checked (partition B's pack, computed
over the aggregate of A+B), because pack A is discarded before any
comparison happens — the file reads as clean corruption. Conversely, an
untouched, perfectly valid two-pack file fails verification outright, because
the aggregate digest over A+B never matches either individual pack's
recorded value — a false-positive "corrupt" report on a legitimate file.

**Why genuine and new.** This is not a classification bug (species 51) or an
arithmetic-implementation gap (species 66) — the digest algorithm itself is
correct. It's a scope mismatch: the code aggregates at file granularity while
the on-disk data model (and the module's own docstring) specifies
per-partition-run granularity. None of species 48–66 involve a
verification-record's declared scope being silently widened past what it was
written to cover.

**The fix.** Bucket essence elements per integrity pack instead of
accumulating file-wide — each `EssenceIntegrityPack` KLV is verified against
only the essence elements seen since the previous pack (or file start), then
the bucket resets:

```python
essence_elements: list[KlvTriplet] = []
pack_count = 0
...
for kl in iter_klv(f):
    if is_essence_element(kl.key):
        essence_elements.append(kl)
    elif is_integrity_pack(kl.key):
        pack_count += 1
        ...
        computed, total = _digest_over_essence(f, essence_elements, pack.algorithm)
        ...
        essence_elements = []
```

`result.ok` is now `True` only if every pack in the file matches; the first
failure's message is preserved in `result.error`. `essence_bytes` and
`essence_element_count` are now sums across all packs rather than a single
snapshot. This required no partition-pack-boundary detection — essence
elements naturally arrive in file order between consecutive integrity packs,
so resetting the bucket after each pack is verified is sufficient and matches
how a real writer closes out each partition's MIC before starting the next.

**Test approach.** Added a `TestMultiPartitionMic` class to
`companion/tests/test_imf_mic.py` with a new `_build_multi_partition_mxf()`
fixture helper (built from the module's own private `_klv`/
`_partition_pack_key`/`_essence_element_key` helpers, since the existing
`build_mxf_with_mic()` only ever produces a single essence run with a single
pack — confirmed by reading the whole file first, which is exactly the
zero-coverage gap the scouting agent flagged). Three tests: two valid
partitions both pass; corrupting the *second* partition's essence is
detected (true under both old and new logic, included for completeness);
corrupting the *first* partition's essence is detected — this is the
regression-distinguishing case, since the old whole-file/last-pack-only logic
discards the first pack before ever comparing against it.

**Verification (mutation testing).** Backed up the fixed file, reverted
`verify_mxf_mic()` to the original whole-file/last-pack-only logic via a
Python find-and-replace, reran: `test_two_valid_partitions_pass` failed
(`ok=False` on a legitimately valid file — `assert False is True`), the other
two multi-partition tests still incidentally passed under the old logic (as
documented in their docstrings), and all 33 pre-existing tests in the file
remained green. Restored the fix: all 36 tests in `test_imf_mic.py` passed,
plus all 7 in `test_imf_qc_mic.py` (the downstream consumer via
`verify_mic_for_assets`), confirming no `MicResult`/`to_dict()` shape
regression for that caller.

**Gate.** `npm run build-verify` passed clean (exit 0). Grepped the full log
for failure markers; all hits confirmed false positives (error-classifier
test names/messages, an OTIO-parse test asserting a literal `SyntaxError`
message).

**Still open.** None for this fix.

Commits: `8035764`.

---

## Iteration 68 — FCPXML fallback scanners hardcoded source-in trim to frame 0

**Why this file.** `src/scripts/parsers/fcpxml.js` is the FCPXML importer.
`parseFCPXML` has a two-tier architecture: a recursive walker `collect()`
handles the normal case, and if it finds zero events, `parseFCPXML` falls
through to two simpler fallback scanners tried in order —
`buildFlatFCPXMLEvents` (subtree-wide `querySelectorAll` for
asset-clip/mc-clip/sync-clip/clip/video, tagged `_fallback:
'flat-sequence-scan'`) and, only if that also finds nothing,
`buildTopLevelFCPXMLEvents` (tagged `_fallback: 'top-level-spine-scan'`).
These exist specifically to salvage events from FCPXML structures that
`collect()`'s recursion doesn't reach — e.g. a `<spine>` nested more than one
level below `<sequence>` inside wrapper elements some exporters emit.

**The bug.** In FCPXML, `start` on a clip element is the source-media
trim-in point — non-zero for virtually any real trimmed clip. Both fallback
scanners reimplement a subset of `collect()`'s field extraction (offset,
duration, name, ref) but never read the `start` attribute, hardcoding
`srcIn: framesToTC(0, fps)` regardless of the clip's actual trim point.

**Concrete failure example.** A sequence whose `<spine>` sits two levels
below `<sequence>` (`<sequence><outer><inner><spine>...`) defeats
`collect()`: its generic `:scope > spine` check only matches a spine that is
a *direct* child of the node currently being visited, and its final
catch-all recursion only descends into children tagged
asset-clip/clip/mc-clip/sync-clip/ref-clip/gap/title — an unrecognized
wrapper tag is none of those, so the recursion never reaches the nested
spine. `parseFCPXML` then falls through to `buildFlatFCPXMLEvents`, whose
subtree-wide scan does find the `<asset-clip>` — but reported `srcIn` as
`00:00:00:00` even when the clip's real `start="480/24s"` (20 seconds into
the source media), silently discarding the trim point on every event
produced through this path.

**Why genuine and new.** Distinct from all 20 previously-fixed FCPXML/EDL/OTIO
bug species (48–67): this is a "fallback-path completeness gap" — the
fallback scanners are not a rare corner case, they're a documented,
deliberately-invoked salvage path for structurally atypical exports, and
they were dropping real trim data on every single event they produced.

**The fix.** Both `buildFlatFCPXMLEvents` and `buildTopLevelFCPXMLEvents` now
read `const srcF = ratToFrames(node.getAttribute('start'), fps);` and use it
for `srcIn: framesToTC(srcF, fps)` / `srcOut: framesToTC(srcF + durF, fps)`,
matching the reference pattern already used by `collect()`'s own `ref-clip`
handling.

**Test approach.** Added a test to `test/parsers/fcpxml.test.mjs` using a
genuine, non-contrived fixture built through the public `parseFCPXML()` API
(no internal functions exported for direct testing): a `<spine>` nested two
levels below `<sequence>` inside `<outer><inner>` wrapper tags, which — per
the structural analysis above — genuinely defeats `collect()` while still
being found by `buildFlatFCPXMLEvents`'s subtree-wide scan. The test asserts
`res._fallback === 'flat-sequence-scan'` (confirming the fallback path was
actually exercised, not `collect()`) and that `srcIn`/`srcOut` reflect the
clip's real `start="480/24s"` (20s) trim point rather than frame 0.

**Verification (mutation testing).** Reverted `buildFlatFCPXMLEvents`'s fix
(dropped the `srcF` read, restored the `framesToTC(0, fps)` hardcode) and
reran: the new test failed with `actual: '00:00:00:00', expected:
'00:00:20:00'` as expected. Restored the fix: all 8 tests in
`fcpxml.test.mjs` passed again. `buildTopLevelFCPXMLEvents`'s parallel fix
was verified by direct source read only (the current fixture, being tried
against `buildFlatFCPXMLEvents` first, doesn't exercise the second-tier
scanner) — constructing a fixture that defeats both the recursive collector
and the flat scanner to mutation-test `buildTopLevelFCPXMLEvents`
independently remains open.

**Gate.** `npm run test:node` passed clean: 72 tests, 71 pass, 1 pre-existing
skip, 0 fail. Grepped the full log for `not ok|✖|AssertionError`; zero real
failures.

**Still open.** No fixture yet constructed that defeats both
`collect()` and `buildFlatFCPXMLEvents` to independently mutation-test
`buildTopLevelFCPXMLEvents`'s parallel fix.

Commits: `3881348`.

---

## Iteration 69 — Animated-transform keyframe times mis-parsed as bare numerator

**Why this file.** `src/scripts/parsers/fcpxml.js`'s `readFCPTransform()`
(called from the main `collect()` walker) reads `<adjust-transform>` /
`<param>` / `<keyframe>` elements — the animated position/scale/rotation
ramps behind any FCP X "Ken Burns"-style pan/zoom or rotate edit — and
attaches the parsed keyframes to the event as `event.transform.keys`.

**The bug.** FCPXML keyframe `time` attributes are rational-time strings
like `"12345/24000s"`, exactly the same format `ratToFrames()` in this same
file special-cases for (its own doc comment explains why naive parsing of
rational FCPXML values is wrong). `readFCPTransform()` instead ran:
```js
const tSec = t.endsWith('s') ? parseFloat(t) : (parseFloat(t) || 0);
```
Both branches of this ternary compute the identical thing — a tell that the
"handle the rational case" branch was never actually implemented.
`parseFloat("12345/24000s")` stops at the first non-numeric character (`/`)
and returns `12345`, not `12345/24000 = 0.514375`.

**Concrete failure example.** A keyframe at `time="12345/24000s"` (0.514375s)
was recorded as `time: 12345` — wrong by a factor of ~24000. Every keyframe
in an animated transform whose numerator isn't a whole number of seconds
gets this same misparse, and because each keyframe's numerator/denominator
pair collapses independently, the resulting `keys[field]` array is not just
scaled wrong but internally inconsistent (different keyframes get different
effective error factors depending on their numerators).

**Why genuine and new.** Distinct from the FCPXML fallback-scanner bug fixed
in Iteration 68 (68 was about the two fallback scanners' `srcIn` field; this
is about `readFCPTransform()`, an entirely separate function invoked from
the primary `collect()` path, and a different field — animated keyframe
timing, not clip source-in). Also distinct from all other previously-fixed
species per full `git log` review before starting.

**The fix.** Added a small `ratToSeconds(val)` helper next to `ratToFrames`
— same rational-parsing logic, but returns exact (unrounded) real seconds
instead of a rounded frame count, since keyframe times aren't being snapped
to a frame grid. `readFCPTransform()` now calls `ratToSeconds(t)` instead of
the broken ternary.

**Test approach.** Added a test to `test/parsers/fcpxml.test.mjs` with a
two-keyframe `<adjust-transform><param key="position">` animation using
`time="12345/24000s"` and `time="24690/24000s"`, asserting
`evs[0].transform.keys.position` contains the exact fractional-second values
(`12345/24000`, `24690/24000`), not the bare numerators.

**Verification (mutation testing).** Reverted `readFCPTransform()`'s call
back to the original broken ternary, reran: the new test failed with
`actual: 12345, expected: 0.514375` as predicted. Restored the fix: all 9
tests in `fcpxml.test.mjs` passed again.

**Gate.** `npm run test:node` passed clean: 73 tests, 72 pass, 1 pre-existing
skip, 0 fail. Grepped the full log for `not ok|✖|AssertionError`; zero real
failures.

**Still open.** None for this fix. (Carried over from Iteration 68: no
fixture yet constructed to independently mutation-test
`buildTopLevelFCPXMLEvents`'s source-in-trim fix.)

Commits: `171d82e`.

---

## Iteration 70 — IMF CPL SourceDuration wrongly defaults to IntrinsicDuration, ignoring EntryPoint

**Why this file.** `companion/src/postflowx_companion/imf_scan.py`'s
`_parse_cpl()` walks an IMF Composition Playlist's `SegmentList` /
`Sequence` / `ResourceList` / `Resource` tree to compute per-resource
durations and the composition's `totalFrames`. `totalFrames` is surfaced to
the UI as the package's overall runtime and drives duration-mismatch
warnings elsewhere in the scan pipeline, so a wrong default here silently
corrupts a headline number.

**The bug.** Per SMPTE ST 2067-3, a `TrackFileResourceType`'s
`SourceDuration` element is optional; when omitted it must default to
`IntrinsicDuration - EntryPoint` (the resource plays out everything after
its EntryPoint skip). The parser instead computed:

```python
src_dur = int(_text(res, "SourceDuration") or str(intrinsic or 0))
...
"sourceDuration": src_dur or intrinsic,
...
total_frames += (src_dur or intrinsic) * repeat
```

— defaulting the omitted case to `IntrinsicDuration` alone, ignoring
`EntryPoint` entirely. The two `or intrinsic` fallbacks compounded the bug:
even on the rare path where `src_dur` legitimately parsed as an explicit
`0`, Python's falsy-`0` would trigger the same wrong `intrinsic` fallback.

**Concrete failure example.** A `<Resource>` with
`<IntrinsicDuration>1000</IntrinsicDuration>`,
`<EntryPoint>200</EntryPoint>`, and no `<SourceDuration>` element at all
should report `sourceDuration = 1000 - 200 = 800`. The old code reported
`1000` — overcounting this resource's (and the whole composition's)
duration by exactly its EntryPoint, 200 frames (8.3s at 24fps).

**Why genuine and new.** Distinct from every previously-fixed species per
`git log | grep 'fix('` review — this is the first fix touching
`imf_scan.py`'s CPL resource-duration defaulting; all FCPXML/keyframe/
fallback-scanner fixes (Iterations 48-69) are in unrelated files/functions.

**The fix.** Compute the SMPTE-2067-3-correct default explicitly:

```python
src_dur_text = _text(res, "SourceDuration")
src_dur = int(src_dur_text) if src_dur_text else max(0, intrinsic - entry)
```

and removed the two redundant `or intrinsic` fallbacks on `sourceDuration`
and `total_frames`, since `src_dur` is now always correctly derived
(including the true `0` case).

**Test approach.** The existing `_minimal_cpl()` fixture in
`companion/tests/test_imf_scan.py` uses an Interop-style
`ReelList/Reel/AssetList/TrackFileList/TrackFile` structure that never
reaches `_parse_cpl`'s `SegmentList`/`Resource`-parsing loop at all (an
existing test's own comment confirms `totalFrames` stays `0` against that
fixture). Added a new `_cpl_with_segment_resource()` fixture builder using
the actual SMPTE-2067-3 shape the parser expects
(`SegmentList/Segment/SequenceList/MainImageSequence/ResourceList/
Resource`), and three tests in a new `TestSourceDurationDefaulting` class:
omitted `SourceDuration` with nonzero `EntryPoint` (asserts `800`, and
`totalFrames == 800`), explicit `SourceDuration` used verbatim, and omitted
`SourceDuration` with `EntryPoint = 0` (equals `intrinsic`, sanity check for
the old code's coincidentally-correct case).

**Verification (mutation testing).** Reverted `_parse_cpl` to the original
three buggy lines, reran `TestSourceDurationDefaulting`: the omitted+nonzero-
EntryPoint test failed with `assert 1000 == 800` exactly as predicted; the
other two (explicit `SourceDuration`, zero `EntryPoint`) still passed, since
those inputs don't exercise the difference. Restored the fix: all 3 new
tests and the full 32-test `test_imf_scan.py` suite passed.

**Gate.** `python3 -m pytest companion/tests/` — 269 passed, 7 skipped, 2
pre-existing failures in `test_conform_engine.py` (`_regional_distance`
calling `int.bit_count()`, a Python 3.10+ API on this machine's Python 3.9.6
— confirmed pre-existing and unrelated by checking `conform_engine.py`
against `git show HEAD`, which shows it already differs from HEAD as part
of the repo's existing uncommitted drift, untouched by this fix).

**Still open.** None for this fix.

Commits: `a8fdd73`.

---

## Iteration 71 — EXR sequence QC and frame-map CSV writer treat frameStart: 0 as absent

**Why this file.** `companion/src/postflowx_companion/api.py` hosts
`CompanionApi`, the request-routed surface the Electron renderer calls into
for OCF/VFX-pull work, including EXR-sequence QC (`qcExrSequence` →
`_qc_exr_sequence`) and pull-sidecar generation (`_write_pull_sidecars`,
which writes the per-frame timeline-to-source CSV used by conform/retime
tooling downstream).

**The bug.** Both `_qc_exr_sequence`'s "Start frame check" and the frame-map
CSV writer computed the job's configured first frame as:

```python
frame_start = int(job.get("frameStart") or 1001)
```

`frameStart` is a legitimate job-config field — most VFX pipelines start
EXR sequences at frame `1001` by convention, but some pipelines legitimately
start at `0`. Python's `or` treats `0` as falsy, so a job explicitly
configured with `frameStart: 0` silently had it discarded and replaced by
the `1001` default, exactly the same footgun class fixed in Iteration 70
for IMF CPL's `SourceDuration`. Four other call sites in this same file
already use the correct presence-check idiom, `job.get("frameStart",
1001)`, which only substitutes the default when the key is absent, not
when it's falsy-but-present — these two sites were the odd ones out.

**Concrete failure example.** A job configured with `frameStart: 0`
exporting an EXR sequence `SHOT_PL_v001.0000.exr` through
`SHOT_PL_v001.0003.exr`: `_qc_exr_sequence` detects the first file's frame
number as `0`, compares it against the wrongly-defaulted `frame_start =
1001`, and emits a spurious `"Frame start: 0 found, 1001 expected"`
warning on an entirely correct export. Separately, `_write_pull_sidecars`'s
frame-map CSV writer computes `out_f = frame_start + i` for every row —
with the same wrong default, every `outputFrame` in the CSV is shifted by
+1001, corrupting the frame map for any downstream conform/retime step that
consumes it.

**Why genuine and new.** Distinct from every previously-fixed species per
`git log | grep 'fix('` review, including Iteration 70 — that fix was in
`imf_scan.py`'s CPL-parsing code; this is the same bug *class*
(falsy-`0`-vs-absent) recurring independently in `api.py`'s EXR/frame-map
code, a different file and different field (`frameStart` vs
`SourceDuration`). Confirmed via `grep -n "frameStart"
companion/src/postflowx_companion/api.py`, which found exactly these 2
buggy sites (lines 4849, 4990) against 4 already-correct sites (lines 2379,
4618, 4726, 5082) using the right idiom.

**The fix.** Switched both sites from `job.get("frameStart") or 1001` to
`job.get("frameStart", 1001)`, matching the codebase's own
already-established-correct idiom used elsewhere in the same file.

**Test approach.** Added two tests to
`companion/tests/test_vfx_pull_exr.py`:
`test_write_pull_sidecars_frame_map_honors_zero_frame_start` (asserts the
first CSV row's `outputFrame` is `0`, not `1001`, for a job with
`frameStart: 0`), and
`test_qc_exr_sequence_zero_frame_start_matches_detected_start` (builds a
real temp directory of 4 empty `.exr` files named
`SHOT_PL_v001.0000.exr`..`.0003.exr`, calls `_qc_exr_sequence` with
`frameStart: 0`, and asserts no `"Frame start"` warning is emitted).

**Verification (mutation testing).** Reverted exactly the two fixed lines
back to `int(job.get("frameStart") or 1001)` (by line number, to avoid
touching the 4 already-correct sites that share the same post-fix text).
Reran the two new tests: both failed exactly as predicted — first
`outputFrame` was `1001` instead of `0`, and the QC warning
`"Frame start: 0 found, 1001 expected"` appeared. Restored the fix from a
backup copy; reran both tests: both passed. Also caught and corrected a
stray Unix permission-bit change (`100755` → `100644`) introduced by the
backup-restore `cp`, by checking the actual committed mode via `git
ls-files -s` (which showed this file is `100755` in the repo, i.e.
intentionally executable) and `chmod`-ing back to `755` before diffing/
committing, so the final diff contains only the 2 intended content lines.

**Gate.** `python3 -m pytest companion/tests/` — 271 passed, 7 skipped, 2
pre-existing failures in `test_conform_engine.py` (`_regional_distance`
calling `int.bit_count()`, a Python 3.10+ API on this machine's Python
3.9.6 — the same pre-existing/unrelated failures confirmed in Iteration
70, untouched by this fix).

**Still open.** None for this fix.

Commits: `08ed84b`.

---

## Iteration 72 — FCPXML conform parser derives durationFrames from the source span instead of the record span

**Why this file.** `src/scripts/modules/conform/edlParser.js` normalizes
EDL / FCP XML / OTIO into a uniform `ConformEvent` list consumed by
downstream conform/retime tooling. It documents its own duration policy
explicitly, in a comment above `parseEdl` (lines 99-100): "Timeline
duration comes from the RECORD TCs (authoritative), not the source TCs —
source points at WIP masters and is re-resolved by matching." `parseEdl`
follows this policy correctly (`durationFrames: Math.max(0, recOutF -
recInF)`); its sibling `parseFcpXml`, which parses FCP7 XML / FCPXML,
did not.

**The bug.** `parseFcpXml` computed:

```js
durationFrames: Math.max(0, srcOut - srcIn),
```

using the clip's *source* `<in>`/`<out>` frame values instead of its
*record* `<start>`/`<end>` values — the exact inverse of the file's stated
policy and of `parseEdl`'s own implementation two functions above it.

**Concrete failure example.** A retimed clip (e.g. a ramp/speed-change)
with source span `<in>100</in><out>148</out>` (48 frames of source media)
but record span `<start>500</start><end>596</end>` (96 frames on the
timeline, because the clip plays at half speed): the buggy code reported
`durationFrames: 48`, silently corrupting the timeline duration for any
FCPXML containing a retime — half the correct value — which propagates
into any conform/retime step consuming this event list.

**Why genuine and new.** Distinct from every previously-fixed species
(48-71) per `git log | grep 'fix('` review. This is a source-vs-record
mixup specific to `parseFcpXml`'s duration computation; `parseEdl`,
`parseOtio`, and every other function in this file already use the
correct span for their respective duration fields.

**The fix.** Changed the source spans to record spans:

```js
// Timeline duration comes from the RECORD TCs (authoritative), not the
// source TCs — source points at WIP masters and is re-resolved by
// matching. See parseEdl above.
durationFrames: Math.max(0, recOut - recIn),
```

**A complication worth documenting.** `edlParser.js` and its existing test
file (`tests-js/edlParserConform.test.mjs`) both carry substantial
pre-existing *uncommitted* drift unrelated to this fix — a full
drop-frame-timecode rewrite (`fpsIsDrop`, rewritten `tcToFrames`/
`framesToTc`), a rewritten `parseEdl` regex (dissolve/wipe/audio-track
handling), and a dynamic FCM line in `eventsToEdl` — none of which had
ever been committed (`git log --oneline -- <path>` showed only the
original `b173ee8` repo-init commit). A naive `git diff --stat` on this
file showed 74 insertions/22 deletions, far larger than this single-hunk
fix, which was the signal that something else was mixed in. Rather than
committing that drift under this iteration's name (or reverting it, which
would destroy unrelated in-progress work), the fix was isolated with a
hand-crafted unified-diff patch applied via `git apply --cached --check`
then `git apply --cached`, staging only the intended 4-line hunk into the
index while leaving the rest of the file's working-tree changes untouched
and unstaged. Likewise, `edlParserConform.test.mjs` is untracked but
already contained both the drift's tests and a duration test overlapping
this fix — committing it whole would have pulled the drift in and created
a commit whose tests reference exports (`fpsIsDrop`) not present in the
scoped source change. Instead, a new, minimal, self-contained test file
was created for just this fix, and left `edlParserConform.test.mjs`
completely untouched.

**Test approach.** New file `tests-js/edlParserFcpXmlDuration.test.mjs`:
constructs an FCPXML clip with source span 48 frames (`in=100, out=148`)
and record span 96 frames (`start=500, end=596`), asserting
`durationFrames === 96` (record span), not `48` (source span).

**Verification.** Ran the new test against the buggy code (pre-fix): failed
with `durationFrames === 48` exactly as predicted. Re-ran after applying
the fix: passed. Additionally verified the *staged* commit's
self-consistency independent of the file's unstaged drift: extracted the
exact index version via `git show :src/scripts/modules/conform/edlParser.js`
into a scratch directory (with `node_modules` symlinked in for `linkedom`),
copied the new test alongside it, and ran it there directly — passed
identically, confirming the commit does not implicitly depend on any of
the unstaged drift.

**Gate.** `npm run test:js` — full green across all `tests-js/*.test.mjs`
files (grepped the full log for `not ok|✖|AssertionError|Error:|FAIL`;
all matches were legitimate "PASS -" assertion-description text, not
actual failures).

**Still open.** The pre-existing uncommitted drift in `edlParser.js` and
`edlParserConform.test.mjs` (drop-frame math, `parseEdl` regex rewrite,
FCM export logic) remains uncommitted and untouched, as it predates this
session and is out of scope for this fix. The scouting agent's other two
flagged candidates (audio correlation in `conform_engine.py`; MIC check
conflation in `imf_qc.py`) remain unaddressed.

Commits: `c9ee0d8`, `7c580a8`.

## Iteration 73 — Python `parse_edl` drops dissolve/wipe events and computes duration from the wrong span

**Why this file.** `companion/src/postflowx_companion/engines/conform_engine.py`'s
`parse_edl` is the Python-side CMX3600 EDL parser feeding
`run_conform_analyze_async` and `_match_events` — the companion-server
counterpart to the JS `edlParser.js` fixed in Iteration 72. A scouting
agent flagged the same bug *class* (dissolve/wipe drop) recurring here in
a different language/function; independent verification during this
iteration also turned up a second, related bug the scouting agent missed.

**The bugs.**
1. **Dissolve/wipe silent drop.** The CMX3600 event regex hardcoded the
   literal edit-type token `C`:
   ```python
   r"^(\d{3,4})\s+(\S+)\s+\S+\s+C\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)"
   ```
   Dissolve (`D`) and wipe (`W###`) lines carry a different edit-type
   letter plus an extra transition-duration field, so they never matched
   and were silently dropped from the parsed event list — no warning, no
   error, just missing events.
2. **Source-vs-record duration.** `duration_frames=max(0, fo - fi)` computed
   duration from `fi`/`fo` — the parsed *source* TC span (`src_in`/`src_out`)
   — instead of the *record* TC span (`rec_in`/`rec_out`), the same bug
   class just fixed in Iteration 72 for `parseFcpXml`, here recurring in a
   sibling Python function.

**Concrete failure example.** An EDL with a cut, a dissolve
(`002  AX  V  D  024  ...`), and a wipe (`003  AX  V  W001  ...`): the old
regex parsed only the cut, silently dropping 2 of 3 events. Downstream,
`_match_events` would either skip the missing events or — if an EDL
consisted entirely of transitions — trip the `RESOLVE_SCRIPT_FAILED: No
events found` error path (confirmed present at 4 call sites via `grep`).
Separately, a event with source span `00:00:00:00`-`00:00:02:00` (48
frames) but record span `01:00:00:00`-`01:00:04:00` (96 frames) reported
`duration_frames=48` instead of the correct `96`.

**Why genuine and new.** Distinct from every previously-fixed species
(48-72). Same bug *class* as Iteration 72 (source-vs-record duration) but
a different file, language, and function (`parse_edl`, not `parseFcpXml`).
The dissolve/wipe-drop bug is a different species than either.

**The fix.** Broadened the regex to accept any transition letter plus an
optional duration token, and switched the duration calculation to use the
record TCs — mirroring the JS sibling `parseEdl()` in `edlParser.js`,
which already handled both correctly and served as the direct model:

```python
# Matches ANY edit-type letter (C/D/W/K/…) and consumes the optional
# dissolve/wipe duration token that follows it, so dissolve and wipe
# events are not silently dropped from the parsed event list.
m = re.match(
    r"^(\d{3,4})\s+(\S+)\s+\S+\s+([A-Z])\s*(?:\d+)?\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)",
    line,
)
...
# Timeline duration comes from the RECORD TCs (authoritative), not
# the source TCs — source points at WIP masters and is re-resolved
# by matching. Mirrors edlParser.js's parseEdl().
fi = _tc_to_frames(rec_in, fps)
fo = _tc_to_frames(rec_out, fps)
```

**A complication worth documenting.** Both the source file and its test
file carried substantial pre-existing uncommitted drift, unrelated to
this fix — an entire "Picture Conform v1.4" visual-matcher feature
(~450 lines: `_visual_status`, `_regional_hash_from_gray`,
`_build_visual_index`, etc.) in `conform_engine.py`, and 4 drift tests
plus drift imports (~100 lines) in `test_conform_engine.py`. This was a
more involved isolation than Iteration 72's single-file case, since two
separate files each needed independent isolation:
- For `conform_engine.py`: extracted the `parse_edl` hunk from a
  `git diff -U5` via `awk`, applied with `git apply --check --cached`
  then `git apply --cached`. First attempt used an incorrect awk
  stop-pattern (`/^@@ -644/` when the actual next hunk header was
  `@@ -642,10 +672,309 @@`), which let the "off" flag never trigger and
  captured ~400 extra lines of unrelated drift into the patch — caught by
  reviewing the full patch output before applying, fixed by using the
  exact header text as the stop-pattern.
- For `test_conform_engine.py`: rather than patch-isolate two new test
  functions out of a drifted file, followed the Iteration 72 precedent
  directly — created a new dedicated file,
  `companion/tests/test_conform_engine_parse_edl.py`, containing just the
  2 new regression tests and their own self-contained imports, leaving
  `test_conform_engine.py` completely untouched (verified via
  `git diff --stat` showing the same original 63-insertion/1-deletion
  drift, unchanged).
- Also discovered mid-iteration: `git stash push -- conform_engine.py`
  (attempted to test the old buggy behavior against a "clean" file)
  reverted the *entire* file to its last commit, stripping the drift-added
  `VIS_GRID` constant that the drift tests in `test_conform_engine.py`
  import, breaking collection with `ImportError: cannot import name
  'VIS_GRID'`. Recovered via `git stash pop`; switched strategy to
  reproducing the old buggy regex/duration logic via standalone Python
  snippets against literal fixture strings instead of touching tracked
  files.

**Test approach.** New file `test_conform_engine_parse_edl.py`:
`test_parse_edl_keeps_dissolve_and_wipe_events` parses a cut+dissolve+wipe
EDL and asserts all 3 events survive; `test_parse_edl_duration_frames_from_record_span_not_source_span`
constructs an event with a 48-frame source span and 96-frame record span,
asserting `duration_frames == 96`.

**Verification.** Confirmed both bugs against the old logic via standalone
regex/arithmetic snippets before fixing. Both new tests pass in isolation
(`pytest companion/tests/test_conform_engine_parse_edl.py -q` → 2 passed).
Full suite: 273 passed, 7 skipped, 2 failed — the 2 failures are the
known pre-existing Python-3.9 `bit_count()` gate (Iterations 70-71),
unrelated to this change; no regressions. Verified the staged commit's
`--cached --stat` showed exactly 13 insertions/7 deletions for
`conform_engine.py`, matching the intended isolated hunk.

**Gate.** `python3 -m pytest companion/tests/` — 273 passed, 7 skipped, 2
pre-existing-unrelated failed (bit_count, Python 3.9 gap).

**Still open.** Both files' pre-existing "Picture Conform v1.4" drift
(visual matcher in `conform_engine.py`; drift tests/imports in
`test_conform_engine.py`) remains completely untouched and uncommitted,
as it predates this session and is out of scope. The scouting agent's
other flagged candidates from prior iterations not yet addressed remain
open.

Commits: `f74f89b`.

## Iteration 74 — DoVi shot metadata's `isCut` mirrored `gapBefore`, so the "Cuts" counter under-reported real shot changes

**Why this file.** `annotateShots()` in
`src/scripts/modules/imf/imf_dovi_metafier.js` walks the Shot list parsed
from a Dolby Vision CM XML metadata track and annotates each Shot with
derived fields consumed by the IMF UI's DoVi timeline panel
(`imf_ui.js`) — including the "Cuts" summary counter, shot-boundary
separators drawn on the timeline, and per-shot gap warnings.

**The bug(s).** `isCut` was defined as `gapBefore > 0` — i.e. a shot only
counted as a "cut" if there was a frame gap between it and the previous
shot. But a DoVi CM XML Shot list is inherently scene-based: every listed
Shot already represents an editorially distinct shot, whether or not
there's a frame-continuity gap at its boundary (well-formed, professionally
mastered content is almost always gapless). Conflating "is a cut" with
"has a gap" meant the "Cuts" counter reported near-zero cuts for exactly
the content it should report the most cuts for.

**Concrete failure example.** A 3-shot, perfectly contiguous DoVi Shot
list (`[0-99], [100-199], [200-299]`, no gaps) has 2 real shot
boundaries. Under the old logic, `gapBefore` is `0` for every shot, so
`isCut` is `false` for every shot, and the "Cuts" counter reads `0`
instead of `2`.

**Why genuine and new.** Not a duplicate of Iterations 48-73's flagged
bug species (TC parsing, matcher drift, EDL parsing, visual scoring,
etc.) — this is a DoVi shot-metadata semantics bug specific to
`imf_dovi_metafier.js`/`imf_ui.js`, confirmed by reading `annotateShots()`
and its consumers directly rather than trusting the scouting report at
face value.

**The fix.** Redefined `isCut` to mean "this Shot starts a new boundary"
(`prev != null`, i.e. true for every shot after the first), independent
of `gapBefore`:

```js
shot.gapBefore = prev != null ? Math.max(0, shot.begin - (prev.end + 1)) : 0;
// Every non-first Shot in the DoVi CM XML is a new shot boundary (an editorial
// cut), regardless of frame continuity. gapBefore separately flags a metadata
// anomaly (missing frames between shots) and is NOT itself a cut signal.
shot.isCut = prev != null;
```

`gapBefore` keeps its original meaning as an independent frame-continuity
anomaly signal, untouched by the `isCut` redefinition.

**A complication worth documenting.** Three consumer sites in
`imf_ui.js` used `shot.isCut` specifically to mean "has a gap" (a gap
marker, a shot tooltip, and a shot-list table badge, all showing
gap-warning UI). Left unchanged, they would have regressed under the new
semantics — firing on nearly every shot instead of only gapped ones.
Updated all three to check `shot.gapBefore > 0` directly instead of
`shot.isCut`, preserving their original gap-only behavior. A fourth site
— the shot-boundary-separator loop's `if (!shot.isCut && shot.gapBefore
=== 0) continue;` guard — became dead code under the new semantics
(equivalent to `if (false) continue`) and was removed, so separators now
draw at every shot boundary as their surrounding naming
("Shot boundary separators", `imf-tl-dv-shot-sep`) already implied was
intended. The "Cuts" summary counter itself (`res.shots?.filter(s =>
s.isCut).length`) needed no change — it becomes correct automatically.

Both source files carried pre-existing uncommitted drift unrelated to
this fix: `imf_dovi_metafier.js` had only a file-mode bit change
(100644→100755, left untouched); `imf_ui.js` had two in-progress hunks
at lines ~1476 (a `pkg.fileMap` Map-handling fix in a PLUGFEST test) and
~1669 (an IAB group-label QC branch), both left completely untouched.
Isolated the 4 intended `imf_ui.js` edits via a hand-crafted
`git apply --cached` patch matched by exact `@@` line-number headers. A
first isolation attempt using a more complex `awk` toggle script
incorrectly captured all 6 hunks (2 drift + 4 intended) due to messy
state-toggling logic — caught by inspecting the patch before applying,
fixed by rewriting as a simpler explicit pattern-match keyed to the
intended hunks' exact headers.

**Test approach.** New file
`tests-js/imfDoviAnnotateShotsCuts.test.mjs`: one case asserts a
contiguous 3-shot sequence reports `isCut` `false/true/true` and 2 total
cuts (not 0), with `gapBefore` staying 0 throughout; a second case
asserts a shot after a genuine 50-frame gap is both `isCut === true` and
reports the real `gapBefore` value, confirming the two fields remain
independently meaningful.

**Verification.** `node tests-js/imfDoviAnnotateShotsCuts.test.mjs` — 7/7
assertions pass. Full `npm run test:js` suite exits cleanly (0 failures)
after staging the new test file (the suite's own
`selfContained.test.mjs` git-tracking gate initially failed because the
new test file was untracked — expected, not a regression; resolved by
`git add`-ing it). Verified the staged commit's `--cached --stat` showed
exactly the intended `5 insertions(+)/1 deletion(-)` in
`imf_dovi_metafier.js` and `7 insertions(+)/2 deletions(-)` in
`imf_ui.js`, with the remaining unstaged `git diff` in both files
matching only their pre-existing untouched drift.

**Gate.** `npm run test:js` — full suite passes, 0 failures.

**Still open.** `imf_ui.js`'s pre-existing drift (PLUGFEST `pkg.fileMap`
fix at ~1476, IAB group-label QC branch at ~1669) and `src/index.html`'s
unrelated drift (new session-store script tag, tab tooltips, tab-group
labels) remain completely untouched and uncommitted, as they predate
this session and are out of scope. The scouting agent's other flagged
candidates from prior iterations not yet addressed remain open.

Commits: `7e905a6`.

## Iteration 75 — IAB `isAtmos` ignored the name-matched bed fallback, misclassifying pure 5.1 tracks as Atmos

**Why this file.** `extractAdmProgrammeTreeFromCompanion()` in
`src/scripts/modules/imf/imf_iab_labels.js` builds the ADM programme-tree
summary (bed/object counts, Atmos/5.1/7.1 flags) from companion-supplied
object names when raw ADM XML isn't available — feeding the IMF UI's IAB
audio QC summary (`_admTree`, `imf_ui.js`).

**The bug.** The function derives its bed count two ways: from the
companion's `objectSummary.bedObjects` count, or — as a fallback — by
regex-matching object *names* for `bed`/`5.1`/`7.1`/`surround` patterns
(`bedObjects`, computed at the top of the function). `objectCount`,
`bedCount`, and `is51` all correctly OR both signals together
(`bedFromSummary || bedObjects.length`), but `isAtmos` only subtracted
`bedFromSummary`, ignoring the name-matched fallback entirely:

```js
objectCount: totalObj - (bedFromSummary || bedObjects.length),
bedCount: bedObjects.length || bedFromSummary,
isAtmos: (totalObj - bedFromSummary) > 0,
is51: bedFromSummary > 0 || bedObjects.length > 0,
```

**Concrete failure example.** A plain 5.1-bed-only track (no dynamic
Atmos objects) with object names
`['L_bed','R_bed','C_bed','LFE_bed','Ls_bed','Rs_bed']`, where the
companion's `objectSummary.bedObjects` is `0`/absent (not populated) but
`totalObjects` is `6`. `bedObjects.length` is `6` via the name-match
fallback, so `objectCount` correctly comes out `0` and `is51` correctly
`true` — but `isAtmos = (6 - 0) > 0 = true`, wrongly flagging a pure 5.1
bed as an Atmos mix.

**Why genuine and new.** A distinct arithmetic inconsistency inside
`imf_iab_labels.js`'s companion-path programme-tree builder — a
different file and function from every prior iteration's flagged
species (DoVi shot metadata, EDL parsing, TC math, visual scoring,
etc.), and unrelated to this file's own pre-existing drift (see below).

**The fix.** Made `isAtmos` use the same OR'd bed count as the other
three derived fields:

```js
isAtmos: (totalObj - (bedFromSummary || bedObjects.length)) > 0,
```

**A complication worth documenting.** `imf_iab_labels.js` carried
pre-existing uncommitted drift unrelated to this fix: a new `cat ===
'object'` branch in `_fixForReject()` (a QC-message helper) and two
`cat === 'object'` additions to REJECT→WARN status downgrades in
`inspectIabAdm()`/`inspectIabAdmFromNames()`, plus a file-mode bit change
(100644→100755). The intended one-line fix (at what was originally line
599) was isolated via a hand-crafted `git apply --cached` patch matched
against its exact `@@ -593,7 +596,7 @@` hunk header, leaving the 3 drift
hunks and mode-bit change unstaged.

**Test approach.** New file `tests-js/imfIabAtmosBedCount.test.mjs`: one
case builds a pure 5.1-bed track (bed-named objects, no
`objectSummary.bedObjects`) and asserts `objectCount === 0`,
`bedCount === 6`, `is51 === true`, and — the regression — `isAtmos ===
false`; a second case confirms a genuine bed+dynamic-object mix still
reports `isAtmos === true`. Confirmed the old logic would have produced
`isAtmos === true` for the first case via a standalone arithmetic check
before fixing.

**Verification.** `node tests-js/imfIabAtmosBedCount.test.mjs` — 6/6
assertions pass. Full `npm run test:js` suite exits cleanly (0
failures). Verified the staged commit's `--cached --stat` showed exactly
the intended `1 insertion(+)/1 deletion(-)` in `imf_iab_labels.js` (plus
the new 37-line test file), with the remaining unstaged `git diff`
matching only the file's pre-existing untouched drift.

**Gate.** `npm run test:js` — full suite passes, 0 failures.

**Still open.** `imf_iab_labels.js`'s pre-existing drift (the `object`
category additions to `_fixForReject()` and the two REJECT→WARN
downgrades) remains completely untouched and uncommitted, as it predates
this session and is out of scope. The scouting agent's other flagged
candidates from prior iterations not yet addressed remain open.

Commits: `5abf65a`.

## Iteration 76 — `aaf_export.py` AAF export was completely non-functional: 7 distinct wrong-property/wrong-class defects across the video and audio exporters

**Found.** Investigating a scouted `comp_clip['StartPosition'].value = src_in`
double-offset bug in `export_nle_linked_aaf()` led to discovering that
`companion/src/postflowx_companion/aaf_export.py` was written against a
property vocabulary that does not match the vendored `pyaaf2` library's
actual AAF class dictionary (`companion/src/aaf2/model/classdefs.py`) at
all. Every one of the module's `SourceClip`/`SourceReference` property
accesses, and two of its `EssenceDescriptor` subclass choices, were wrong
— meaning both `export_nle_linked_aaf()` (video/NLE-linked AAF) and
`export_protools_aaf()` (audio/Pro Tools AAF) raised immediately on any
real payload and had apparently never worked.

**The 7 defects, in the order each was uncovered by iterative
`KeyError`/`AttributeError` failures on a real end-to-end export run:**

1. **`Timecode(..., start=tl_start)` kwarg.** `f.create.Timecode()` takes
   no `start` kwarg in this vendored version; fixed by constructing bare
   and assigning `tc_obj.start = tl_start` afterward. (Same bug present
   at both call sites — video's `tl_start` and audio's `tl_start_s`.)
2. **`ImportDescriptor` has no `SampleRate`/`Length`.** Its classdef
   entry (`classdefs.py` line 484) has an empty property dict — those
   fields only exist on `FileDescriptor` and its subclasses. The video
   resolved-media branch was swapped to `DataEssenceDescriptor` (extends
   `FileDescriptor` directly, its one extra property `DataEssenceCoding`
   is optional — no additional mandatory fields to satisfy, unlike
   `CDCIDescriptor`, which was tried first and rejected: it requires 7
   mandatory frame-geometry fields — `ComponentWidth`,
   `HorizontalSubsampling`, `StoredHeight`, `StoredWidth`, `FrameLayout`,
   `VideoLineMap`, `ImageAspectRatio` — that this code has no source data
   to populate, since it only tracks fps/duration/path).
3. **`TapeDescriptor['TapeName']` doesn't exist.** Its real properties
   (`classdefs.py` lines 308-317) are `FormFactor, VideoSignal,
   TapeFormat, Length, ManufacturerID, Model, TapeBatchNumber,
   TapeStock` — no `TapeName`. Fixed by removing the line; the reel
   identity is already carried by `sm.name = reel` set earlier in the
   same block.
4. **`export_protools_aaf()`'s unresolved/linked audio branch had the
   same `ImportDescriptor` bug as #2**, fixed by swapping to
   `WAVEDescriptor` (a `FileDescriptor` subclass already proven correct
   one branch earlier in the same function's embed path).
5. **`desc.locators.append(loc)` (plural) is not a real attribute** on
   any `EssenceDescriptor`-derived class — `EssenceDescriptor` defines
   only a singular `.locator` property (`essence.py` line 50-52) backed
   by the `'Locator'` dict key. Always raised `AttributeError`. Fixed in
   both the video and audio linked-media branches.
6. **`SourceClip`/`SourceReference` wrong property names.**
   `['StartPosition']` and `['SourceSlotID']` don't exist anywhere in
   the AAF dictionary for this or any ancestor class — the real
   properties (`classdefs.py` lines 79-93) are `StartTime` and
   `SourceMobSlotID`. Fixed all 8 occurrences (4 in each of the video
   and audio paths' `mm_clip`/`comp_clip` construction) using the
   vendor's own idiomatic Python wrappers: `.start` (→`StartTime`) and
   `.slot_id` (→`SourceMobSlotID`), per `components.py`'s `SourceClip`/
   `SourceReference` property definitions.
7. **The original scouted bug**: `comp_clip.start = src_in` double-applied
   the source in-point. The MasterMob's own `SourceClip` already re-bases
   the SourceMob's file-relative `src_in` offset to local frame 0 (its
   Sequence spans `[0, src_dur)`); the CompositionMob's `SourceClip`,
   which references that MasterMob, must start at local frame 0, not
   `src_in` again — double-applying it pushed every video event with a
   nonzero source in-point off its MasterMob's valid range. Fixed to
   `comp_clip.start = 0`.

**Test approach.** New file `companion/tests/test_aaf_export_nle.py`
drives `export_nle_linked_aaf()` end-to-end with a real dummy `.mov`
path and a nonzero source in-point (`01:00:10:00` → frame 90250 @
25fps), then opens the resulting AAF via `aaf2.open()` and asserts the
CompositionMob's `SourceClip.start == 0` and the MasterMob's
`SourceClip.start == 90250`. Also fixed two latent test-authoring bugs
discovered while writing the assertions: `media_kind` returns the
datadef's title-cased `short_name` (`'Picture'`, not `'picture'`) even
though it's *set* with the lowercase convenience string, and the
correct accessor for a `SourceClip`'s referenced mob is `.mob`, not a
nonexistent `.source_mob`. A parallel manual smoke test exercised
`export_protools_aaf()`'s linked-audio branch (the `WAVEDescriptor`
swap) end-to-end and confirmed `status: 'ok'`.

**Verification.** `python3 -m pytest tests/test_aaf_export_nle.py -v` —
1/1 passes. Full `python3 -m pytest -q` in `companion/` — 274 passed, 7
skipped, 2 failed; both failures (`test_conform_engine.py`'s
`_regional_distance` tests) are pre-existing and unrelated — they call
`int.bit_count()`, added in Python 3.10, on this environment's Python
3.9.6, nothing to do with AAF export. `npm run test:js` — 22/22 pass, 0
failures.

**A complication worth documenting.** `aaf_export.py` carried
pre-existing drift unrelated to this fix: a file-mode bit change
(100644→100755). All of this iteration's content fixes were isolated
into the git index via a hand-crafted `git apply --cached` patch (the
full `git diff` with its `old mode`/`new mode` lines stripped before
applying), leaving only the mode-bit change unstaged.

**Gate.** `python3 -m pytest tests/test_aaf_export_nle.py -v` and
`npm run test:js` both pass cleanly.

**Still open.** `aaf_export.py`'s pre-existing mode-bit drift
(100644→100755) remains untouched and uncommitted, as it predates this
session and is out of scope. The scope of this iteration grew far
beyond the single originally-scouted bug — nearly every AAF property
access in this module was wrong — which is why all 7 defects are
documented together as one iteration rather than split across several:
they were discovered serially, each only surfacing once the prior one
was fixed and the export ran one step further, and none is independently
meaningful without the others (the export function did not produce a
valid AAF until all 7 were fixed together). The video resolved-media
branch's `DataEssenceDescriptor` choice is a functionally-correct but
semantically loose fit (it's meant for non-AV data essence, not video) —
NLEs performing a true frame-accurate relink by pixel format/resolution
may still want real `CDCIDescriptor` geometry fields once the payload
carries that data; flagged for a future iteration if this surfaces in
real-world use, not fixed now since inventing frame dimensions the code
doesn't have would be worse than using a lightweight placeholder
descriptor that NLEs can still relink by reel/timecode/path.

Commits: `0f67670`.

## Iteration 77 — `check_all()`'s Photon detection silently reported an installed, on-PATH Photon binary as "not found"

**Why this file.** `check_all()` in
`companion/src/postflowx_companion/media_engine/engine_status.py`
populates the Engine Status panel shown in the app UI (via
`engine_status_for_ui()` → `/api/media/status`), reporting whether
optional/required media tools (ffmpeg, mpv, Grok, Photon, Resolve, etc.)
are installed and runnable.

**The bug.** The Photon lookup was meant to be a 3-way fallback chain —
check `PATH` for `photon`, then `pfx-photon`, then a hardcoded
`~/bin/photon` — written as:

```python
photon_bin = (shutil.which("photon") or
              shutil.which("pfx-photon") or
              str(Path.home() / "bin" / "photon") if (Path.home() / "bin" / "photon").exists() else None)
```

Python's conditional expression (`X if C else Y`) binds *looser* than
`or`, so this doesn't parse as `A or B or (C if exists else None)` — it
parses as `(A or B or C) if exists else None`. The `~/bin/photon`
`.exists()` check therefore gates the *entire* expression, including the
two `shutil.which()` calls that have nothing to do with that path.

**Concrete failure example.** A user with Photon installed via Homebrew
(so `shutil.which("photon")` returns e.g. `/usr/local/bin/photon`, the
normal, documented install path) but with no file at `~/bin/photon` (the
common case — `~/bin/photon` is a last-resort fallback location, not
where anyone is expected to put it) gets `photon_bin = None`, and the
Engine Status panel wrongly shows "Photon (IMF reference validator):
Not found (optional)" even though Photon is fully installed and
runnable.

**Why genuine and new.** Confirmed via `ast.parse` that the expression's
actual parse tree is `IfExp(test=.exists(), body=Or[...], orelse=None)`,
and reproduced live with `shutil.which` mocked to return a path for
`"photon"` while `~/bin/photon` doesn't exist — `photon_bin` came back
`None`. Every other tool-detection block in this same file (ffmpeg, mpv,
ojph via `_which_first`; Grok via a flat `or` chain) uses a correctly
short-circuiting `or` chain with no such precedence trap, confirming
this was a one-off authoring slip in the Photon block specifically, not
an intentional gate.

**The fix.** Parenthesized the fallback so the existence check only
gates its own literal branch:

```python
home_photon = Path.home() / "bin" / "photon"
photon_bin = (
    shutil.which("photon")
    or shutil.which("pfx-photon")
    or (str(home_photon) if home_photon.exists() else None)
)
```

**Test approach.** New file `companion/tests/test_engine_status_photon.py`
with two cases: (1) `shutil.which` mocked to resolve `"photon"` to a
fake path while `Path.home()` points at a tmp dir with no `bin/photon`
— asserts `results["Photon"]["available"] is True` and the path matches
the mocked `which` result; (2) `shutil.which` mocked to return nothing
for anything, `Path.home()` pointed at a tmp dir where `bin/photon` does
exist — asserts the legitimate fallback still resolves. Confirmed case
(1) fails against the pre-fix code (`assert False is True`) via a
`git stash`/re-run/`git stash pop` round-trip, and both pass post-fix.

**Verification.** `python3 -m pytest tests/test_engine_status_photon.py -v`
— 2/2 pass. Full companion suite: `python3 -m pytest -q` — 276 passed, 7
skipped, and the same 2 pre-existing `test_conform_engine.py` failures
noted in Iteration 76 (`int.bit_count()` requires Python 3.10+; this
environment runs 3.9.6) — unrelated, untouched, out of scope.

**Gate.** Full companion pytest suite — passes except the 2 pre-existing,
unrelated Python-version failures already documented in Iteration 76.

**Still open.** The `int.bit_count()` / Python 3.9 incompatibility in
`conform_engine.py` remains unfixed (flagged in Iteration 76, still out
of scope — it's an environment/version issue, not a logic bug). The
scouting agent found no other `aaf2`-touching call sites with the same
wrong-property/wrong-class pattern as Iteration 76; this iteration's bug
is unrelated to AAF, found via a broader sweep of `media_engine/`.

Commits: `8cec8cc`.

## Iteration 78 — Proxy-generation progress update mutated a throwaway copy and never reached the session store

**Why this file.** `generate_proxy_async()` in
`companion/src/postflowx_companion/media_engine/proxy_engine.py` runs a
proxy transcode on a background thread and reports progress into the
in-memory session store (`service_state.py`) so the UI can poll
`GET`-style session status endpoints and show "Queued… / Transcoding…
5% / Proxy ready" as the job advances.

**The bug.** The mid-run progress update was written as:

```python
state = get_session(session_id) or {}
state.update({"stage": "transcoding", "message": "Transcoding…", "pct": 5})
```

`service_state.get_session()` deliberately returns `dict(state)` — a
fresh copy of the stored session, not a reference to it — precisely so
callers can't accidentally mutate the store by hand. `_run()` did
exactly that anyway: it grabbed a copy, updated the copy, and then
never did anything with it. The mutated copy is discarded at the end
of the `try` block; `update_session()` (the function that actually
writes back to `_sessions`) isn't even imported in this file.

**Concrete failure example.** A client calls the proxy-transcode
endpoint, gets a `sessionId`, and polls it while ffmpeg runs. Because
the "transcoding / 5%" write never reaches the store, the poll response
stays frozen at `{"stage": "queued", "pct": 0}` for the entire transcode
— which can be minutes for a large source — then jumps straight to
`complete`/`failed` (those terminal states use `create_session()`,
which does write through). A UI or any timeout/retry logic watching for
forward progress would read this as a hung job.

**Why genuine and new.** Confirmed `get_session()`'s copy-return
behavior by reading `service_state.py` directly, confirmed `state` in
`_run()` is never referenced again after the `.update()` call, and
confirmed `update_session` isn't imported anywhere in `proxy_engine.py`
— it's only used for the two terminal states via `create_session()`
(which overwrites the whole session dict, unrelated to this bug).
Independently re-derived the same conclusion the scouting agent
reported, then verified it against the running code.

**The fix.** Call `update_session()` directly instead of mutating a
throwaway copy:

```python
from ..service_state import create_session, update_session
...
update_session(session_id, stage="transcoding", message="Transcoding…", pct=5)
```

**Test approach.** New file
`companion/tests/test_proxy_engine_async_progress.py`: monkeypatches
`proxy_engine.generate_proxy` with a fake that signals a
`threading.Event` once it starts (simulating "the transcode has begun")
and blocks on a second `Event` until released. The test waits for the
first event, then reads `service_state.get_session()` directly and
asserts `stage == "transcoding"` and `pct == 5`, then releases the
worker to finish. Confirmed this fails against the pre-fix code
(`assert 'queued' == 'transcoding'`) via a `git stash`/re-run/
`git stash pop` round-trip, and passes post-fix.

**Verification.**
`python3 -m pytest tests/test_proxy_engine_async_progress.py -v` — 1/1
pass. Full companion suite: `python3 -m pytest -q` — 277 passed, 7
skipped, and the same 2 pre-existing `test_conform_engine.py` failures
from Iterations 76/77 (`int.bit_count()` needs Python 3.10+; this
environment runs 3.9.6) — unrelated, untouched, out of scope.

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented in
Iteration 76.

**Still open.** The `int.bit_count()` / Python 3.9 incompatibility in
`conform_engine.py` remains unfixed (environment/version issue, not a
logic bug, out of scope). Other async job runners in this codebase
(e.g. `proxy_service.py`) were spot-checked and correctly call
`update_session()` for progress — `proxy_engine.py`'s `generate_proxy_async`
was the one outlier using this pattern.

Commits: `177def9`.

## Iteration 79 — VFX Pull's `pullReportFile` and `manifestFile` sidecars were the same path, so every export clobbered the pull report

**Why this file.** `packagePaths.js` is the single factory for every VFX
Pull sidecar path (AMF, FDL, manifest, frame map, geometry/resize,
color, pull report, QC), consumed by both the JS export flow and the
Python `native_helper_client`/`api.py` sidecar writer. A naming mistake
here silently propagates into every plate's on-disk package.

**The bug.** `buildPackagePaths()` defined
`pullReportFile: \`${root}/metadata/${plateName}_manifest.json\`` —
byte-identical to `manifestFile`'s path, a copy-paste-without-rename
mistake. Both files are written for the same plate within the same VFX
Pull export run: `_runExrExport()` (`vfxPullPanel.js:6411`) calls
`nativeWritePullSidecars(job, qcResult)` (`vfxPullPanel.js:5610`),
which round-trips through `native_helper_client.js` → `api.py`'s
`_write_pull_sidecars` (line 4942) and writes a rich
`schemaVersion: "2.0"` JSON (retime/geometry/colorPlan/qtReference/
colorMatch/frameMatch/output/qc) to `pkg["pullReportFile"]`. Later in
the same export function, `_buildVfxPackageFiles(exportOpts,
_state.exrResults || [])` (`vfxPullPanel.js:6441`) builds a
structurally different naming manifest (shotName, plateName, frame
range, timecodes, ocfPath, matchConfidence, qcStatus) and writes it to
`pkg.manifestFile` — the same on-disk path pre-fix.

**Concrete failure example.** Export plate `SHOT_010_PL01_v001` with
the default (non-manifest-only) render engine: the Python-written pull
report (retime/geometry/color-match/QC data downstream VFX tools
depend on) lands at `.../metadata/SHOT_010_PL01_v001_manifest.json`
first, then the JS-written naming manifest overwrites that exact same
file moments later — the pull report is gone, replaced by a document
with none of that data.

**Why genuine and new.** Verified this isn't a latent/unreached
defect: `_runExrExport`'s manifest-only branch skips the EXR
render/pull-sidecar step, but the default full-render branch (the
common case) executes both writers unconditionally in the same
function for the same job, confirmed by reading
`vfxPullPanel.js:6400-6450` in full. Distinct from the wrong-API-name
(Iteration 74), operator-precedence (Iteration 77), and
`get_session()`-copy-mutation (Iteration 78) bug species already swept
for.

**The fix.** Gave `pullReportFile` its own suffix:
`${root}/metadata/${plateName}_pull_report.json`. Also updated the two
hardcoded fixture strings in `companion/tests/test_vfx_pull_exr.py`
(lines 299, 360) from `_manifest.json` to `_pull_report.json` for
consistency, though those fixtures are self-contained and didn't
require the change for correctness.

**Test approach.** New file
`tests-js/packagePaths_sidecarCollision.test.mjs`: calls
`buildPackagePaths()` and asserts `manifestFile !== pullReportFile`,
that `pullReportFile` carries its own suffix, and that no two sidecar
keys in the returned object resolve to the same path (excluding the
intentional `geometryFile`/`resizeFile` alias pair). Confirmed this
fails pre-fix (1 pass / 3 fail) and passes post-fix (4/4) via a
`git stash`/re-run/`git stash pop` round-trip on `packagePaths.js`.

**Verification.**
`node tests-js/packagePaths_sidecarCollision.test.mjs` — 4/4 pass.
`python3 -m pytest tests/test_vfx_pull_exr.py -q` — 21/21 pass. Full
companion suite: `python3 -m pytest -q` — 277 passed, 7 skipped, same
2 pre-existing `test_conform_engine.py` failures from Iterations
76-78 (`int.bit_count()` needs Python 3.10+; this environment runs
3.9.6) — unrelated, untouched, out of scope. Full JS suite:
`npm run test:js` — 0 failures across every test file.

**Gate.** Full companion pytest suite and full JS test suite — both
pass except the 2 pre-existing, unrelated Python-version failures
already documented in Iteration 76.

**Still open.** The `int.bit_count()` / Python 3.9 incompatibility in
`conform_engine.py` remains unfixed (environment/version issue, not a
logic bug, out of scope). Other sidecar keys in `packagePaths.js` were
audited for the same collision pattern as part of writing this fix's
test — none found beyond the intentional `geometryFile`/`resizeFile`
alias.

Commits: `060024c`.

## Iteration 80 — OCF probe's `timecodeBase` floored NTSC-pulldown frame rates instead of rounding

**Why this file.** `ocf_probe.py`'s `probe_ocf_clip()` is the OCF-probe
entry point for camera-original media, wired into the companion
command dispatch (`api.py` registers `"ocfEngineProbe"`), and its
output feeds the OCF ingest / VFX Pull / ACES-look probe results used
by router, decode, and UI badge logic.

**The bug.** Line 190 computed
`tc_base = fps["num"] // fps["den"] if fps["den"] else 24` — integer
floor division instead of rounding to derive the nominal timecode base
from an exact (rational) frame rate. For the most common professional
cinema NTSC-pulldown rates this floors one frame low:
`24000/1001` (23.976 fps) → `23` instead of `24`; `30000/1001`
(29.97 fps) → `29` instead of `30`; `60000/1001` (59.94 fps) → `59`
instead of `60`.

**Concrete failure example.** Probing an ARRI/RED/Sony/Canon clip shot
at 23.976 fps returns `timecode.timecodeBase: 23`. Any downstream
timecode-frame-count arithmetic or UI display trusting this field is
off by one frame at every second boundary.

**Why genuine and new.** A sibling module in the same codebase,
`media_engine/media_probe.py` (line 310), computes the equivalent
value correctly via `round(fps_val)`, confirming the intended
convention and that `ocf_probe.py` diverged from it — not an
alternate deliberate design. `probe_ocf_clip()` is reachable via the
normal `ocfEngineProbe` dispatch path, not dead code. Distinct from
the wrong-API-name, operator-precedence, `get_session()`-copy-mutation,
and sidecar-path-collision species already swept for in Iterations
74-79.

**The fix.** Changed line 190 to
`tc_base = round(fps["num"] / fps["den"]) if fps["den"] else 24`,
mirroring `media_probe.py`'s convention.

**Test approach.** New file `companion/tests/test_ocf_probe_tc_base.py`
(4 tests), following the same fake-ffprobe pattern as
`test_probe_ocf_tc_out.py`: monkeypatches `subprocess.run` to return a
fake ffprobe JSON payload with a given `r_frame_rate`, calls
`probe_ocf_clip()` against a real (empty) temp file, and asserts
`timecode.timecodeBase` for 23.976/29.97/59.94 fps (expect
24/30/60) plus an integer-rate case (25/1 → 25) to confirm no
regression. Confirmed all 3 fractional-rate cases fail pre-fix
(23/29/59) and pass post-fix via a `git stash`/re-run/`git stash pop`
round-trip on `ocf_probe.py`.

**Verification.**
`python3 -m pytest tests/test_ocf_probe_tc_base.py -v` — 4/4 pass.
Full companion suite: `python3 -m pytest -q` — 281 passed, 7 skipped,
same 2 pre-existing `test_conform_engine.py` failures from Iterations
76-79 (`int.bit_count()` needs Python 3.10+; this environment runs
3.9.6) — unrelated, untouched, out of scope.

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented in
Iteration 76.

**Still open.** The `int.bit_count()` / Python 3.9 incompatibility in
`conform_engine.py` remains unfixed (environment/version issue, not a
logic bug, out of scope). Other timecode/frame-rate math sites in the
companion codebase were not exhaustively re-audited this iteration;
`_tc_source`/`_fps_info` in `ocf_probe.py` itself were read and are
unaffected by this fix.

Commits: `8378d50`.

## Iteration 81 — BRAW backend always decoded frames as RGBA even though the SDK reports BGRA on some platforms/GPUs

**Why this file.** `companion/src/postflowx_companion/media/backends/braw_backend.py`
implements `BrawBackend`, the still-frame decode path for `.braw` clips
via ctypes calls into the Blackmagic RAW SDK's COM-style vtable
interfaces. `get_frame()` is the public entry point invoked on every
preview/thumbnail/seek-frame request when the SDK is present.

**The bug.** `_save_frame()` (formerly lines 477-486) contained the
comment `# BRAW SDK returns BGRA or RGBA depending on platform` /
`# Detect byte order: if it's BGRA swap R/B channels`, but the actual
code unconditionally called
`Image.frombytes("RGBA", (w, h), data, "raw", "RGBA", bpr)` — no
detection logic existed anywhere in the file.
`IBlackmagicRawFrame::GetResourceType` (vtable slot 6, constant
`_FRAME_GetResourceType` defined at line 102) was never called from
any site in the file, confirming the intended detection was never
wired up, not that it was deliberately skipped.

**Concrete failure example.** On any platform/GPU combination where
the BRAW SDK's async decode callback (`_FrameCallback._read_complete`)
returns frame bytes packed as BGRA rather than RGBA, every BRAW
preview/thumbnail/seek-frame image silently has its red and blue
channels swapped — skin tones and color-critical VFX reference frames
would look visibly wrong with no error surfaced anywhere.

**Why genuine and new.** Independently verified by reading the full
call chain: `get_frame()` (line 283) → `_decode_frame_rgba()` (line
426) → `_decode_frame_rgba_locked()` (line 435) →
`_FrameCallback._read_complete` (line 134, the callback that actually
copies raw bytes via `_FRAME_GetBytes`) → `_save_frame()` (call site
line 302). This is the sole, fully-implemented BRAW still-frame decode
path — not dead code, not gated behind an unreachable flag. Confirmed
via a dedicated grep that `_FRAME_GetResourceType` has exactly one
occurrence in the file (its definition) prior to this fix. A new bug
species: an SDK/platform-dependent pixel-format assumption hardcoded
despite a code comment acknowledging the variability — distinct from
the wrong-API-name, operator-precedence, `get_session()`-copy-mutation,
sidecar-path-collision, and floor-division species already swept for
in Iterations 74-80.

**The fix.** Added `_raw_mode_for_resource_type()`, a pure helper
mapping a `GetResourceType()` code to a PIL raw mode (`"BGRA"` for the
known BGRA-packed resource-type codes, `"RGBA"` otherwise). Extended
`_FrameCallback._read_complete` to also call `_FRAME_GetResourceType`
on the decoded frame and thread the result through
`_decode_frame_rgba_locked()`'s return tuple (now 5-tuple:
`w, h, bpr, raw_bytes, resource_type`). `_save_frame()` now picks the
PIL raw mode via the new helper instead of hardcoding `"RGBA"`.
`_save_frame_via_ffmpeg()` (the no-Pillow fallback) similarly picks
`ffmpeg`'s `-pix_fmt` (`bgra` vs `rgba`) from the same resource type
instead of hardcoding `rgba`.

**Test approach.** New file `companion/tests/test_braw_backend_bgra.py`
(4 tests) exercising the pure `_raw_mode_for_resource_type()` helper
directly (RGBA code → `"RGBA"`, each known BGRA code → `"BGRA"`,
unknown code → defaults to `"RGBA"`), plus one test that calls
`_save_frame()` with a stubbed-in fake `PIL.Image` module to confirm
it passes the correct raw mode through end-to-end for both a BGRA and
an RGBA resource type. No real BRAW SDK is required — the helper and
`_save_frame()` are pure/mockable, consistent with how the module's
ctypes SDK calls are already fully lazy (never invoked at import
time). Confirmed the test file fails to even collect
(`ImportError: cannot import name '_raw_mode_for_resource_type'`)
against pre-fix code and passes 4/4 post-fix via a stash/pop
round-trip on `braw_backend.py`.

**Verification.**
`python3 -m pytest tests/test_braw_backend_bgra.py -v` — 4/4 pass.
Full companion suite: `python3 -m pytest -q` — 285 passed, 7 skipped,
same 2 pre-existing `test_conform_engine.py` failures from Iterations
76-80 (`int.bit_count()` needs Python 3.10+; this environment runs
3.9.6) — unrelated, untouched, out of scope.

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented in
Iteration 76.

**Still open.** The exact integer values of the BRAW SDK's
`_BlackmagicRawResourceFormat` enum could not be verified against the
vendor's official header from this environment (no SDK/header present,
offline); the fix uses the values documented in Blackmagic's publicly
distributed sample code
(`blackmagicRawResourceFormatRGBAU8 = 0`,
`blackmagicRawResourceFormatBGRAU8 = 1`,
`blackmagicRawResourceFormatBGRAU8Planar = 8`). If a future BRAW SDK
revision changes these codes, `_raw_mode_for_resource_type()` is the
single place to update. The `int.bit_count()` / Python 3.9
incompatibility in `conform_engine.py` remains unfixed (environment
issue, out of scope).

Commits: `dd8c190`.

## Iteration 82 — FFmpeg frame server's cache filename ignored the source clip, so concurrent decode requests for different clips could collide

**Why this file.**
`companion/src/postflowx_companion/media_engine/ffmpeg_frame_server.py`
implements `FFmpegFrameServerEngine`, the fallback/primary frame decode
path for image sequences, MXF J2K/HTJ2K, and the MPV-unsupported
fallback route, invoked via `POST /api/media/decode-frame` in
`http_server.py`.

**The bug.** `decode_frame()`'s output path (line 56, pre-fix) was
`frame_dir / f"frame_{frame_number:07d}.{output_format}"` — built only
from `frame_number` and `output_format`, never from `path` (the source
clip) or any session/request identifier. Every sibling cache in this
codebase keys on source identity: `frame_cache.py`'s `make_key()`
hashes `session_id:frame_index:...`; the other backend modules hash
`path:frame_index:...`. This file was the sole outlier.

**Concrete failure example.** The companion HTTP server runs as a
`ThreadingHTTPServer` (`http_server.py:813`), so each request handles
in its own thread. Two different clips being scrubbed/previewed
concurrently (e.g. two panels open at once) both requesting
`frame_number=100` at the default scale/format compute the identical
path `<tmpdir>/postflowx_frames/frame_0000100.png`. Their `ffmpeg -y`
subprocess calls race to write that same file; the
`out_file.is_file() and out_file.stat().st_size > 0` check can pass on
a file mid-overwrite by the other request, so one caller's returned
`imagePath` can silently show a frame decoded from the wrong clip.

**Why genuine and new.** Confirmed reachable: `media_router.py`
selects `FFmpegFrameServerEngine` as primary for image sequences (line
38) and MXF J2K/HTJ2K (line 60), and as a listed fallback for MOV/MXF
DNx/ProRes, browser-unsafe media, and the MPV-fallback route — not a
rare path. Confirmed `ThreadingHTTPServer` (not a single-threaded
server) via `http_server.py:813/826`. Confirmed zero prior mentions of
`ffmpeg_frame_server`/`FFmpegFrameServerEngine` across all 81 prior
iteration entries. A new instance of an established species (see
Iteration 79's sidecar-path-collision), here manifesting as a
cross-clip cache-key collision rather than a same-clip sidecar
collision.

**The fix.** Added `_frame_cache_key(path, frame_number, scale,
output_format)`, hashing all four inputs via SHA256 — matching the
convention already used by `frame_cache.py`'s `make_key()` and the
per-backend cache-key builders. `decode_frame()`'s `out_file` now uses
`frame_{cache_key}.{output_format}` instead of the frame-number-only
name.

**Test approach.** New file
`companion/tests/test_ffmpeg_frame_server_cache_key.py` (4 tests):
the pure `_frame_cache_key()` helper (different paths → different
keys; same inputs → same key; varying frame_number/scale/format →
different keys), plus an end-to-end test that stubs `subprocess.run`
and confirms `decode_frame()` for two different clip paths (same
frame_number/format) produces two distinct output file paths.
Confirmed the test file fails to even collect
(`ImportError: cannot import name '_frame_cache_key'`) against pre-fix
code, and passes 4/4 post-fix, via a stash/pop round-trip on
`ffmpeg_frame_server.py`.

**Verification.**
`python3 -m pytest tests/test_ffmpeg_frame_server_cache_key.py -v` —
4/4 pass. Full companion suite: `python3 -m pytest -q` — 289 passed, 7
skipped, same 2 pre-existing `test_conform_engine.py` failures from
Iterations 76-81 (`int.bit_count()` needs Python 3.10+; unrelated, out
of scope).

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented in
Iteration 76.

**Still open.** The fix resolves the cross-clip collision but does not
add an atomic temp-file + `os.replace()` write for the case where two
requests target the *same* clip/frame/scale/format concurrently (e.g.
two panels previewing the identical frame of the same clip at once) —
left as-is since that case is idempotent (both writers produce
byte-identical output for the same inputs), unlike the cross-clip case
this iteration fixes. The `int.bit_count()` / Python 3.9
incompatibility in `conform_engine.py` remains unfixed (environment
issue, out of scope).

Commits: `21910a5`.

## Iteration 83 — `standard_media_backend.py`'s `_frames_to_tc()` truncated fractional fps instead of rounding, drifting NTSC-rate timecodes

**Why this file.** `companion/src/postflowx_companion/media/backends/standard_media_backend.py`
is the default ffprobe+ffmpeg backend for still-frame preview/thumbnail/scrub
requests on the most common delivery formats (MP4, MOV/ProRes, MXF, WebM,
MKV) — any codec not requiring a native SDK backend routes through here.

**The bug.** `_frames_to_tc()` converted a frame index to a timecode using
`int(fps)` as the frame-counting divisor:

```python
def _frames_to_tc(frames: int, fps: float) -> str:
    fps = max(1.0, fps)
    ff  = frames % int(fps)
    s   = (frames // int(fps)) % 60
    m   = (frames // int(fps) // 60) % 60
    h   = frames // int(fps) // 3600
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"
```

`fps` comes straight from ffprobe's `r_frame_rate` (`get_frame()` at line
139), so for any NTSC-derived rate — 23.976, 29.97, 47.952, 59.94, 119.88,
near-universal in professional cinema/broadcast delivery — `int(fps)`
truncates to the rate one below the nominal rate (`int(23.976) == 23`,
not `24`), dropping a frame's worth of count every second of footage.

**Concrete failure example.** For a 23.976fps clip at `frame_index=100`,
the correct nominal-24fps timecode is `00:00:04:04`. The buggy code computes
`100 % 23 = 8`, `100 // 23 = 4`, yielding `00:00:04:08` — wrong, and the
drift compounds roughly every 24 frames as the frame index grows (at
`frame_index=10000` the two disagree by whole seconds, not just a frame or
two). This surfaces directly in the API response's `"timecode"` field
(`get_frame()` line 204) for every still-frame preview/thumbnail/scrub
request routed through this backend.

**Why genuine and new.** Every other frames↔timecode conversion in this
codebase deliberately rounds fps to its nominal whole-frame rate first —
`aaf_export.py` (`fps_int = max(1, round(fps))`), `api.py`
(`int(round(fps))`), `conform_engine.py` (`int(round(fps))`), and the
module-level `_tc_to_frames`/`_frames_to_tc` functions fixed into
`_probe_ocf_file` back in Iteration 49. In fact, Iteration 49's own
"Still open" note explicitly flagged this exact file as a known,
deferred instance of the bug ("Iteration 48's `int(fps)` grep sweep
across the rest of `companion/src/postflowx_companion/` remains pending
(its two known instances in `standard_media_backend.py`/`aaf_export.py`
are still dirty files, off-limits)") — `aaf_export.py`'s instance was
fixed by Iteration 76's broader AAF rewrite, but `standard_media_backend.py`'s
was never actually revisited until now.

**The fix.** Round `fps` to its nearest whole-frame rate once, then use
that for all four divisions:

```python
def _frames_to_tc(frames: int, fps: float) -> str:
    fps_int = max(1, round(max(1.0, fps)))
    ff  = frames % fps_int
    s   = (frames // fps_int) % 60
    m   = (frames // fps_int // 60) % 60
    h   = frames // fps_int // 3600
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"
```

**Test approach.** Added `test_standard_media_backend_ntsc_tc.py` (4
tests): 23.976fps and 29.97fps cases asserting the correct nominal-rate
timecode (not the truncated one), a whole-number-fps control case
confirming the fix doesn't disturb the already-correct integer-fps path,
and a large-frame-index case (`frame_index=10000`) confirming the drift
would compound to whole seconds if the bug were reintroduced.

**Verification.** `python3 -m pytest tests/test_standard_media_backend_ntsc_tc.py -v`
— 4/4 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`standard_media_backend.py`: reverting to pre-fix code fails 3/4 tests
exactly as predicted (`00:00:04:08` instead of `00:00:04:04`,
`00:00:10:10` instead of `00:00:10:00`), the whole-number-fps control
case still passes (unaffected by the bug). Restored the fix, reran —
4/4 green. Full companion suite: `python3 -m pytest -q` — 293 passed (up
from 289), 7 skipped, same 2 pre-existing `test_conform_engine.py`
failures from Iterations 76-82 (`int.bit_count()` needs Python 3.10+;
unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented since
Iteration 76.

**Still open.** The `int.bit_count()` / Python 3.9 incompatibility in
`conform_engine.py` remains unfixed (environment issue, out of scope).

Commits: `3e954e2`.

## Iteration 84 — `color_lut.py`'s `_write_cube()` wrote IDT LUTs with Red and Blue axes swapped

**Why this file.** `companion/src/postflowx_companion/color_lut.py`
generates the per-camera-family `.cube` 3D LUTs (ARRI LogC3/LogC4, RED
Log3G10, Sony S-Log3, Canon C-Log2, Panasonic V-Log → ACES2065-1) used
by the VFX Pull / EXR render path whenever `job.colorPlan.idtName` names
a known camera log family. `get_idt_lut_path()` caches the generated
file under `~/.postflowx/idt_luts/idt_<family>.cube` and `api.py` wires
it into ffmpeg's filter chain via `-vf lut3d=...` at both the normal
render path (`api.py` around line 2532-2536) and the freeze-frame bake
path (`api.py` around lines 2588-2590) — so this LUT touches every
EXR/review-proxy render for a job with a known camera IDT.

**The bug.** The `.cube` format (Adobe/Iridas spec, consumed by
ffmpeg's `lut3d` filter) requires the 3D lattice to be written with
**Red varying fastest, then Green, then Blue**. `_write_cube()` nested
its loops backwards — `for ri: for gi: for bi:`, i.e. Blue varying
fastest — with a comment incorrectly asserting this was the correct
order:

```python
# .cube iteration order: B varies fastest, then G, then R.
for ri in range(size):
    r = ri * step
    for gi in range(size):
        g = gi * step
        for bi in range(size):
            b = bi * step
            or_, og, ob = fn(r, g, b)
            lines.append(f"{or_:.6f} {og:.6f} {ob:.6f}")
```

Because ffmpeg's `lut3d` filter indexes the file assuming R is the
fastest axis, every sample it reads for a given input pixel actually
comes from the wrong lattice point whenever R and B differ — the red
and blue channels of the applied IDT transform get swapped. For any
shot with a real camera IDT applied (which is most VFX Pull work), this
silently inverts red/blue color balance in the rendered EXRs — e.g. a
warm ARRI LogC3 skin tone would render distinctly blue-shifted instead.

**Why genuine and new.** The sibling generator
`tools/gen_aces2_luts.py`'s `write_cube()` implements the correct
convention (`for b: for g: for r:`, R innermost/fastest) with an
explicit correct comment ("`.cube` order: red varies fastest") and is
validated directly against OCIO via `companion/tests/test_aces2_luts.py`
(`test_lut_matches_ocio`) — confirming R-fastest is in fact the
established, tested-correct convention elsewhere in this same codebase.
`color_lut.py`'s independent `_write_cube()` implementation never had
that validation and had the axes backwards. No prior audit entry
mentions `color_lut.py`, `_write_cube`, or `.cube` axis order — this is
a new bug species (LUT lattice iteration-order mismatch against a
documented file-format convention), not a duplicate of any earlier
iteration.

**The fix.** Swap the loop nesting so R is innermost (fastest-varying)
and B is outermost, matching `gen_aces2_luts.py`'s convention, and
correct the misleading comment:

```python
# .cube iteration order: R varies fastest, then G, then B (Adobe/Iridas
# spec; matches tools/gen_aces2_luts.py's write_cube(), which is
# validated against OCIO directly).
for bi in range(size):
    b = bi * step
    for gi in range(size):
        g = gi * step
        for ri in range(size):
            r = ri * step
            or_, og, ob = fn(r, g, b)
            lines.append(f"{or_:.6f} {og:.6f} {ob:.6f}")
```

**Test approach.** Added `test_color_lut_cube_axis_order.py`: writes a
3x3x3 identity-transform `.cube` file via `_write_cube()` and parses its
data rows directly, asserting row 1 differs from row 0 only in R (the
fastest axis), row 3 (after one full R cycle) increments G with R
reset, and row 9 (after one full R*G cycle) increments B with R and G
reset — a direct, format-level check of the lattice iteration order
independent of any specific camera transform.

**Verification.** `python3 -m pytest tests/test_color_lut_cube_axis_order.py -v`
— 1/1 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`color_lut.py`: reverting to pre-fix code fails the test exactly as
predicted (row 1 comes out `(0.0, 0.0, 0.5)` — B changed, not R).
Restored the fix, reran — 1/1 green. Full companion suite:
`python3 -m pytest -q` — 294 passed (up from 293), 7 skipped, same 2
pre-existing `test_conform_engine.py` failures from Iterations 76-83
(`int.bit_count()` needs Python 3.10+; unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented since
Iteration 76.

**Still open.** The `int.bit_count()` / Python 3.9 incompatibility in
`conform_engine.py` remains unfixed (environment issue, out of scope).
The other five camera-family transforms in `color_lut.py`'s registry
were not individually re-validated against OCIO (only the lattice
iteration order was tested) — a follow-up could add an
`test_lut_matches_ocio`-style cross-check for `color_lut.py`'s
transforms too, mirroring `test_aces2_luts.py`'s coverage.

Commits: `7b53433`.

## Iteration 85 — `color_lut.py`'s `_logc4_to_lin()` used fabricated ARRI LogC4 decode constants, ~1500x off at 18% grey

**Why this file.** Same file as Iteration 84, `companion/src/postflowx_
companion/color_lut.py` — its `_logc4_to_lin()` linearizes ARRI LogC4
(Alexa 35) code values before the AWG4→AP0 matrix, feeding every ARRI
Alexa 35 IDT `.cube` LUT used by the VFX Pull / EXR render path via
`api.py`'s `-vf lut3d=...` filter chain.

**The bug.** The decode used a comment claiming "Formula from ARRI
Alexa 35 LogC4 Specification" but the actual constants
(`2.0 ** (e * 18.0 - 4.0)`, `2.0 ** -4`, `2.0 ** 14 - 2.0 ** -4`) do not
appear anywhere in ARRI's real LogC4 spec — they don't match its
documented piecewise formula or any of its named constants (`a`, `b`,
`c`, `s`, `t`). At LogC4's own documented 18%-grey code value (0.28),
the old formula decoded to `0.00012168794304251554` instead of the
correct `~0.18361188651480678` scene-linear value — roughly **1500x**
too dark. Every Alexa 35 shot run through this IDT path had its
midtones (and the rest of the curve) catastrophically crushed.

**Independent verification.** A background scouting agent flagged this
with a proposed replacement formula and constants. Rather than trust
the report at face value, fetched ARRI's official LogC4 Specification
(1 May 2022, `arri.com/resource/blob/278790/...`) and cross-checked
against OpenColorIO's `arri.generate` reference implementation
(`opencolorio-config-aces`). Both independently confirm the exact same
piecewise formula and constants the agent proposed:
`a = (2^18-16)/117.45`, `b = (1023-95)/1023`, `c = 95/1023`,
`s = (7·ln(2)·2^(7-14c/b)) / (a·b)`, `t = (2^(-14c/b+6) - 64) / a`, with
decode `L = V·s + t` for `V < 0` (linear extension for post-production-
introduced negative values ARRI cameras never emit) and
`L = (2^(14·(V-c)/b + 6) - 64) / a` for `V ≥ 0`. Confirmed the two
branches are continuous at `V = 0` (both evaluate to `t ≈ -0.01806`) —
a mathematical sanity check independent of the source-matching. Grepped
`PostFlowX_Audit_Report.md` for `LogC4`/`_logc4`/`Alexa 35` beforehand —
no prior entry, not a duplicate of Iteration 84 (which only fixed the
`.cube` lattice axis order in the same file, not any camera transform's
math — its "Still open" note flagged exactly this class of gap).

**The fix.** Replaced the fabricated constants and formula with the
spec-verified piecewise decode:

```python
_LC4_A = (2.0 ** 18 - 16.0) / 117.45
_LC4_B = (1023.0 - 95.0) / 1023.0
_LC4_C = 95.0 / 1023.0
_LC4_S = (7.0 * math.log(2.0) * 2.0 ** (7.0 - 14.0 * _LC4_C / _LC4_B)) / (_LC4_A * _LC4_B)
_LC4_T = (2.0 ** (-14.0 * _LC4_C / _LC4_B + 6.0) - 64.0) / _LC4_A

def _logc4_to_lin(e: float) -> float:
    if e < 0.0:
        return e * _LC4_S + _LC4_T
    return (2.0 ** (14.0 * (e - _LC4_C) / _LC4_B + 6.0) - 64.0) / _LC4_A
```

Also removed the old `max(0.0, ...)` clamp — the spec's linear branch
can legitimately produce slightly negative scene-linear values near
code value 0 (matching `_logc3_to_lin()`'s existing unclamped
convention elsewhere in this same file).

**Test approach.** Added `test_color_lut_logc4_decode.py` (3 tests):
`_logc4_to_lin(0.28)` matches the spec-derived 18%-grey value to 9
decimal places, the two piecewise branches are continuous at `V = 0`,
and `_logc4_to_lin(1.0)` matches the spec's documented max value
(`469.8`).

**Verification.** `python3 -m pytest tests/test_color_lut_logc4_decode.py -v`
— 3/3 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`color_lut.py`: reverting to pre-fix code fails 2/3 tests exactly as
predicted (`0.28` decodes to the old `0.0001217` value; `1.0` decodes to
`1.0` instead of `469.8`; the continuity check still passes since both
old-code branches trivially agree — there was only ever one branch).
Restored the fix, reran — 3/3 green. Full companion suite:
`python3 -m pytest -q` — 297 passed (up from 294), 7 skipped, same 2
pre-existing `test_conform_engine.py` failures from Iterations 76-83
(unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented since
Iteration 76.

**Still open.** `color_lut.py`'s other camera-family transforms
(LogC3, RED Log3G10, Sony S-Log3, Canon C-Log2, Panasonic V-Log) were
not re-verified against their respective vendor specs this iteration —
only LogC4 was flagged and checked. A follow-up should audit each
remaining transform's constants against its cited spec the same way,
given this iteration proves the "formula cites a spec in a comment but
the constants don't actually match it" bug species is real in this
file. This is a new (10th) bug species for the seed list: constants/
formula transcribed incorrectly from a cited external specification,
undetected because no test ever checked the transform's numeric output
against a known reference value.

Commits: `a6f3afc`.

## Iteration 86 — `color_lut.py`'s `_log3g10_to_lin()` used a wrong RED Log3G10 decode formula, missing the documented black-point offset

**Why this file.** Iteration 85's "Still open" note flagged `color_lut.py`'s
other camera-family transforms — including RED Log3G10 — as unaudited
against their cited specs. A scouting agent (background, non-user
input) was launched to check them and reported `_log3g10_to_lin()`.

**The bug.** The old code's comment cited "RED Log3G10 Technical
Primer" but implemented `lin = sign(e) · (10^(|e|/0.224282) − 1) /
155.975327` — a symmetric, mirrored-log formula with no black-point
offset. RED's actual spec is asymmetric: a documented linear extension
below `V = 0`, and a `- c` (black-point) term in the positive branch
that the old code omitted entirely. At `V = 0` the old code decoded to
`0.0` instead of the spec's `-0.01`; at 18%-grey's encoded value
(`1/3`) it decoded to `0.1900008...` instead of the correct
`0.1800008...` — wrong in both black level and midtone exposure for
every RED Log3G10/IPP2 IDT LUT.

**Independent verification.** Checked RED's official white paper
(915-0187 Rev-C, "White Paper on REDWideGamutRGB and Log3G10") via
WebSearch, which defines the decode as `V < 0: L = V/g − c`; `V ≥ 0:
L = (10^(V/a) − 1)/b − c`, with `a=0.224282`, `b=155.975327`, `c=0.01`,
`g=15.1927`. Cross-checked against a community C reference
implementation of the same formula — both match. Grepped
`PostFlowX_Audit_Report.md` for "Log3G10" beforehand — no prior entry,
only flagged as unaudited in Iterations 84/85's "Still open" notes.

**The fix.** Replaced the formula with the spec-verified piecewise
decode:

```python
_L3G10_A = 0.224282
_L3G10_B = 155.975327
_L3G10_C = 0.01
_L3G10_G = 15.1927

def _log3g10_to_lin(e: float) -> float:
    if e < 0.0:
        return e / _L3G10_G - _L3G10_C
    return (10.0 ** (e / _L3G10_A) - 1.0) / _L3G10_B - _L3G10_C
```

**Test approach.** Added `test_color_lut_log3g10_decode.py` (3 tests):
`_log3g10_to_lin(0.0)` matches the spec's black-point offset (`-0.01`),
`_log3g10_to_lin(1.0/3.0)` matches the spec-derived 18%-grey value to 9
decimal places, and the negative branch matches the documented linear
extension `V/g - c` directly.

**Verification.** `python3 -m pytest tests/test_color_lut_log3g10_decode.py -v`
— 3/3 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`color_lut.py`: reverting to pre-fix code fails all 3 tests with
exactly the old broken-formula values (`0.0`, `0.1900008495474476`,
`-0.004300906171734946`). Restored the fix, reran — 3/3 green. Full
companion suite: `python3 -m pytest -q` — 300 passed (up from 297), 7
skipped, same 2 pre-existing `test_conform_engine.py` failures from
Iterations 76-83 (unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented since
Iteration 76.

**Still open.** This is the second consecutive iteration to find a
spec-mismatch bug in `color_lut.py` (10th bug species, established
Iteration 85). `_logc3_to_lin()`, `_slog3_to_lin()` (Sony S-Log3),
`_clog2_to_lin()` (Canon C-Log2), and `_vlog_to_lin()` (Panasonic
V-Log) remain unaudited against their respective vendor specs — a
follow-up iteration should check each the same way.

Commits: `3093eab`.

## Iteration 87 — `color_lut.py`'s `_clog2_to_lin()` dropped Canon C-Log2's 0.9 scale factor and used a wrong branch-cutoff constant

**Why this file.** Iteration 86's "Still open" note flagged `_clog2_to_lin()`
(Canon C-Log2) as unaudited against its vendor spec, alongside LogC3,
S-Log3, and V-Log. A scouting agent (background, non-user input) was
launched to check all four and reported a bug in `_clog2_to_lin()`;
it reported LogC3, S-Log3, and V-Log as clean, which was **not**
independently re-verified this iteration — only the C-Log2 finding was.

**The bug.** The old code implemented the decode as `(10^((e −
0.092864125)/0.24136) − 1) / 87.099375` (positive branch) with a
branch cutoff at `_CLOG2_CUT_DEC = -0.00218`. Canon's spec has a
leading `0.9` scene-reflectance scale factor applied outside the log
term in both branches, which the old code omitted entirely — making
every decoded value ~11% too bright. The cutoff constant was also
wrong: `-0.00218` is not the code value where `L = 0`; the correct
cutoff is `0.092864125` (the same constant already used inside the log
term). Since virtually all real-world code values are well above
`-0.00218`, the code always took the "positive" branch regardless of
whether the true encoded value was above or below middle grey.

**Independent verification.** Canon's official "Canon Log Gamma
Curves" white paper (checked via both `usa.canon.com` and
`downloads.canon.com` mirrors, and a locally downloaded copy run
through `pdftotext`) states its equations as images — the appendix
section headings for Canon Log 2 extract as plain text but the actual
formulas do not, so the PDF is not usable as a machine-checkable
source. Fell back to the widely-used open-source `colour-science`
library's `log_encoding_CanonLog2`/`log_decoding_CanonLog2` reference
implementation as the authoritative cross-check, converting its
full-range-domain constants into the legal-range domain used by this
codebase (via the 10-bit SMPTE `full = (legal·1024 − 64)/876`
transform). This confirmed the codebase's existing constants
(`0.24136`, `0.092864125`, `87.099375`) were already correct and the
only bugs were the missing `0.9` factor and the wrong cutoff constant.

**The fix.**

```python
_CLOG2_CUT_DEC = 0.092864125

def _clog2_to_lin(e: float) -> float:
    if e > _CLOG2_CUT_DEC:
        return 0.9 * (10.0 ** ((e - 0.092864125) / 0.24136) - 1.0) / 87.099375
    return -0.9 * (10.0 ** ((-e + 0.092864125) / 0.24136) - 1.0) / 87.099375
```

**Test approach.** Added `test_color_lut_clog2_decode.py` (3 tests):
18%-grey's encoded value (`0.39786577438259785`) decodes to the
spec-derived linear value (`0.17929687995696894`, within ~0.4% of
exact `0.18` — attributable to `colour-science`'s independently
curve-fit constants differing slightly from Canon's own rounded
published ones, consistent with the residual precision noise accepted
in Iterations 85/86); the decode is continuous across the branch cut;
and `L = 0` exactly at the cutoff code value.

**Verification.** `python3 -m pytest tests/test_color_lut_clog2_decode.py -v`
— 3/3 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`color_lut.py`: reverting to pre-fix code fails
`test_clog2_eighteen_percent_grey` with the old formula's exact output
(`0.19921875550774326` instead of `0.17929687995696894`); the other
two tests pass even against old code, as expected, since the old
cutoff constant (`-0.00218`) is far from the region they probe.
Restored the fix, reran — 3/3 green. Full companion suite: `python3 -m
pytest -q` — 303 passed (up from 300), 7 skipped, same 2 pre-existing
`test_conform_engine.py` failures from Iterations 76-83 (unrelated,
out of scope).

**Gate.** Full companion pytest suite — passes except the 2
pre-existing, unrelated Python-version failures already documented since
Iteration 76.

**Still open.** This is the third consecutive iteration to find a
spec-mismatch bug in `color_lut.py` (10th bug species, established
Iteration 85). `_logc3_to_lin()`, `_slog3_to_lin()` (Sony S-Log3), and
`_vlog_to_lin()` (Panasonic V-Log) were reported clean by this
iteration's scouting agent but have not been independently
re-verified — a follow-up iteration should either independently verify
those three or pivot to sweeping a different file/bug species, since
`color_lut.py` may now be largely exhausted for this species.

Commits: `317d358`.

## Iteration 88 — `ocf_proxy.py`'s `generate_proxy()` keyed its output filename only on clip basename, causing cross-project proxy collisions

**Why this file.** Iteration 87's "Still open" note suggested pivoting away
from `color_lut.py` after three consecutive spec-mismatch findings there. A
scouting agent (background, non-user input) was seeded with the ten
established bug species and instructed to prioritize files outside
`color_lut.py`. It reported a cache/output-filename-collision bug (species
#7, first established by `proxy_service.py`'s `_stable_proxy_cache_key`
fix) in `ocf_engine/ocf_proxy.py`.

**The bug.** `generate_proxy()` writes to a single shared
`_OCF_PROXY_DIR` (`~/Library/Application Support/PostFlowX/ocf_proxies`)
whenever the caller doesn't supply `output_dir`, and constructed the output
filename as `f"{_safe_stem(clip_path)}_proxy.mov"` — a sanitized basename
with no folder path, size, mtime, or content-identity signal. Camera
OCF reel/card names commonly reset per shoot day or card format (e.g.
`A001_C001_01.mov`), so two different projects each containing a clip with
that reel name silently overwrite each other's proxy in the shared cache
dir — or, since generation runs on a background thread via
`generate_proxy_async`, potentially corrupt each other's output via
concurrent writes to the same path. The QC/review panel would then
silently display the wrong project's footage.

**Independent verification.** Read `ocf_proxy.py` in full to confirm the
filename construction and shared-directory default. Grepped
`proxy_service.py` and confirmed `_stable_proxy_cache_key()` /
`_proxy_cache_path()` already document this exact bug class having been
fixed there previously (SHA1 of folder+cpl_path+size+mtime), for IMF
proxies — establishing the precedent pattern this fix follows. Grepped
`api.py`'s `_ocf_engine_generate_proxy()` handler and confirmed
`output_dir` defaults to `None` when the request doesn't include
`outputDir` — not documented as a required caller param. Grepped/read the
actual UI caller chain, `ocfViewer.js` (`_startProxy()`, line 339) →
`ocfEngine.js`'s `ocfGenerateProxy()` (lines 96-97), and confirmed the
real desktop-app call site never passes `outputDir` at all — so the
shared-directory, basename-only-keyed path is not a rare edge case but
the only path actually exercised in production.

**The fix.** Added `_source_identity_key(clip_path)` — a 12-hex-char SHA1
of the resolved path, size, and mtime (falling back to the resolved path
alone if `os.stat` fails), mirroring `_stable_proxy_cache_key`'s
approach — and mixed it into the output filename:

```python
out_dir = Path(output_dir) if output_dir else _ensure_proxy_dir()
stem    = _safe_stem(clip_path)
ident   = _source_identity_key(clip_path)
out_path = str(out_dir / f"{stem}_{ident}_proxy.mov")
```

**Test approach.** Added `test_ocf_proxy_filename_identity.py` (3 tests):
two different source files sharing a reel-style basename get different
identity keys; the same file gets a stable key across calls; a missing
file doesn't raise. No existing test file covered `ocf_proxy.py` at all
prior to this iteration.

**Verification.** `python3 -m pytest tests/test_ocf_proxy_filename_identity.py -v`
— 3/3 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`ocf_proxy.py`: reverting to pre-fix code fails test collection outright
with `ImportError: cannot import name '_source_identity_key'` (the helper
doesn't exist pre-fix). Restored the fix, reran — 3/3 green. Full
companion suite: `python3 -m pytest -q` — 306 passed (up from 303), 7
skipped, same 2 pre-existing `test_conform_engine.py` failures from
Iterations 76-83 (unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2 pre-existing,
unrelated Python-version failures already documented since Iteration 76.

**Still open.** This is the second instance of bug species #7 (cache/
output filename omitting resource identity) — the first being
`proxy_service.py`'s IMF proxy cache, fixed prior to this audit loop. A
follow-up iteration should check whether other proxy/cache-writing code
paths in the codebase (e.g. thumbnail or waveform caches) have the same
basename-only-keying gap.

Commits: `1b0ce99`.

## Iteration 89 — `media_engine/proxy_engine.py`'s `generate_proxy()` also keyed its output filename only on the source stem, colliding on the network-exposed transcode-proxy endpoint

**Why this file.** Iteration 88 fixed the first sibling instance of bug
species #7 in `ocf_engine/ocf_proxy.py`. A scouting agent (background,
non-user input) was seeded with the ten established bug species and
explicitly steered to check other proxy/cache/thumbnail/waveform-writing
code paths, since this species had now been found twice. It reported a
second, architecturally distinct instance in `media_engine/proxy_engine.py`.

**The bug.** `generate_proxy()` built its output path as
`out_dir / f"{stem}_proxy{ext}"`, where `stem = Path(source_path).stem` —
no folder, size, mtime, or content-identity signal. Unlike the OCF case,
this module accepted a `source_hash: str = ""` parameter that was stored
into the sidecar JSON metadata (`meta["sourceHash"]`) but never used to
disambiguate `out_file` — and `generate_proxy_async()`, the only caller
actually reachable from the HTTP API, doesn't even forward `source_hash`
(its own signature doesn't accept it either), making the parameter fully
dead in the real call chain.

**Independent verification.** Read `proxy_engine.py` in full and confirmed
the filename construction and the dead `source_hash` parameter. Grepped
`http_server.py` (lines 568-583) and confirmed the `/api/media/transcode-proxy`
endpoint reads `sourcePath` and `outputDir` directly from the untrusted
JSON request body, with zero uniqueness guard, and calls
`generate_proxy_async()` — confirming this is a real, network-exposed path,
not a rare edge case. Grepped `media_engine/__init__.py` and confirmed this
module's `generate_proxy_async` (distinct from `ocf_engine/ocf_proxy.py`'s
same-named function, which is wired separately via `api.py`) is the one
actually exported and used by `http_server.py`. Read the one existing
related test, `test_proxy_engine_async_progress.py` (an Iteration 78
regression test for an unrelated session-write-through bug), and confirmed
it monkeypatches `generate_proxy` entirely — it never exercises the
filename-construction logic, leaving this bug with zero test coverage.
Concrete failure scenario: two source clips sharing a filename stem (e.g. a
reused camera reel name across folders/reels) transcoded to the same
`outputDir` via `POST /api/media/transcode-proxy` collide at
`out_dir/proxies/{stem}_proxy.{mp4|mov}` — the second transcode silently
overwrites the first's proxy file and JSON sidecar, and any consumer
holding the first job's `proxyPath` is served the second source's content.

**The fix.** Added `_source_identity_key(source_path)` — the same
12-hex-char SHA1-of-resolved-path/size/mtime approach used in
`ocf_proxy.py` and originally established by `proxy_service.py`'s
`_stable_proxy_cache_key` — and mixed it into the output filename:

```python
stem = src.stem
ext = ".mp4" if codec == "h264" else ".mov"
ident = _source_identity_key(source_path)
out_file = out_dir / f"{stem}_{ident}_proxy{ext}"
```

**Test approach.** Added `test_proxy_engine_filename_identity.py` (4
tests): two different source files sharing a stem get different identity
keys; the same file gets a stable key across calls; a missing file doesn't
raise; and — mocking `transcode_proxy` to capture the constructed output
path — two different sources sharing a stem transcoded to the same
`outputDir` via `generate_proxy()` produce different output paths (the
direct regression case for the reported collision).

**Verification.** `python3 -m pytest tests/test_proxy_engine_filename_identity.py -v`
— 4/4 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`proxy_engine.py`: reverting to pre-fix code fails test collection outright
with `ImportError: cannot import name '_source_identity_key'` (the helper
doesn't exist pre-fix). Restored the fix, reran — 4/4 green, and confirmed
via `git diff --stat` that only the intended 17-insertion/1-deletion fix
diff was restored. Full companion suite: `python3 -m pytest -q` — 310
passed (up from 306), 7 skipped, same 2 pre-existing `test_conform_engine.py`
failures from Iterations 76-83 (unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2 pre-existing,
unrelated Python-version failures already documented since Iteration 76.

**Still open.** This is the third instance of bug species #7 (cache/output
filename omitting resource identity) — after `proxy_service.py`'s IMF
proxy cache and `ocf_proxy.py`'s OCF clip proxy cache. The species is now
well-covered across the proxy-writing subsystem; a follow-up scouting pass
should either do one more sweep for remaining cache-writing paths (e.g.
thumbnail/waveform caches, still unconfirmed either way) or pivot toward
other bug species/files given how saturated #7 now is here.

Commits: `c915b4e`.

## Iteration 90 — `http_server.py`'s `_preview_proxy_path()` ignored the available `cache_key`, and its `/cache/lookup/` fallback trusted any file at the collided path with zero identity check

**Why this file.** Iterations 88-89 fixed two sibling instances of bug
species #7 in the proxy-generation subsystem (`ocf_proxy.py`,
`media_engine/proxy_engine.py`). A scouting agent (background, non-user
input) was seeded with the ten established bug species and explicitly
steered away from re-scouting the proxy subsystem specifically for species
#7 (already fixed three times: `proxy_service.py`, `ocf_proxy.py`,
`proxy_engine.py`), while still leaving other cache-writing paths
(thumbnail/waveform, the browser-preview cache) fair game. It reported a
fourth, architecturally distinct instance in `http_server.py`'s
browser-preview cache path.

**The bug.** `_preview_proxy_path(out_dir, orig_name)` derived the cache
path purely from `_safe_proxy_stem(orig_name)` — the sanitized basename of
the original filename — with no `cache_key` folded in, even though both
call sites already had a `cache_key` value in scope. This was
architecturally worse than a simple overwrite: `_preview_cache_entries()`
(the *preferred* lookup path) already keys its returned dict by the
sidecar JSON's `cacheKey` field and works correctly. But the `/cache/lookup/`
GET handler's *fallback* — used whenever the cacheKey-keyed sidecar lookup
misses — recomputed the basename-derived candidate path and accepted
*any* existing file there, checking only `is_file()` and `size > 0`, with
zero identity verification, then unconditionally returned
`{"found": True, "outputPath": ...}`.

**Independent verification.** Read `http_server.py` lines 75-204 (helpers:
`_safe_proxy_stem`, `_preview_root`, `_preview_proxy_path`,
`_preview_cache_entries`), 320-389 (`/cache/lookup/` GET handler), and
610-680 (`/upload/` POST handler) in full. Confirmed `_preview_proxy_path`
took only `(out_dir, orig_name)` with no `cache_key` parameter, confirmed
both call sites (`/cache/lookup/`'s fallback and `/upload/`'s
`output_path` construction) already had a `cache_key` variable in scope
that was silently dropped, and confirmed the exact fallback logic:
`is_file() and size > 0` with no cache-key/identity comparison before
returning `found: True`. Grepped the file and confirmed exactly 3
references to `_preview_proxy_path` (1 definition, 2 call sites) — no call
site was missed by the fix. Read `test_http_server.py` and confirmed it
covers only token auth, range requests, and path traversal — zero existing
coverage of `_preview_proxy_path`, `_preview_cache_entries`, `/cache/lookup/`,
or `/upload/`. Concrete failure scenario: two uploads sharing a basename
(e.g. the same-named clip re-uploaded from a different folder or camera
card) under different `cache_key`/session values collide on the identical
`{out_dir}/{stem}_proxy.mp4` path; a second session's `/cache/lookup/`
call — landing on the fallback because its own cacheKey isn't in any
sidecar yet — finds the first session's file sitting at that path and
reports `found: True`, handing back a stale, unrelated source's proxy.

**The fix.** Added an optional `cache_key: str = ""` parameter to
`_preview_proxy_path()`, sanitized and folded into the filename stem when
present (falls back to the original basename-only path when empty, so any
caller not supplying a `cache_key` is unaffected):

```python
def _preview_proxy_path(out_dir: str, orig_name: str, cache_key: str = "") -> str:
    root = _preview_root(out_dir)
    if root is None:
        return ""
    stem = _safe_proxy_stem(orig_name)
    key = str(cache_key or "").strip()
    if key:
        safe_key = "".join(ch if ch.isalnum() else "_" for ch in key)[:40]
        stem = f"{stem}_{safe_key}"
    return str(root / f"{stem}_proxy.mp4")
```

Updated both call sites — the `/cache/lookup/` fallback and `/upload/`'s
`output_path` construction — to pass the already-available `cache_key`
variable through.

**Test approach.** Added `test_http_server_preview_cache_identity.py` (3
tests): two uploads sharing a basename but different `cache_key` values
get different paths (the direct regression case for the reported
collision); the same `cache_key` and basename produce a stable path across
calls; and an empty `cache_key` falls back to the original basename-only
path (backward-compatibility check).

**Verification.** `python3 -m pytest tests/test_http_server_preview_cache_identity.py -v`
— 3/3 pass post-fix. Confirmed genuine via a stash/pop round-trip on
`http_server.py`: reverting to pre-fix code fails all 3 tests with
`TypeError: _preview_proxy_path() takes 2 positional arguments but 3 were
given` (the pre-fix signature has no third parameter). Restored the fix,
reran — 3/3 green, and confirmed via `git diff --stat` that only the
intended 9-insertion/4-deletion fix diff was restored. Full companion
suite: `python3 -m pytest -q` — 313 passed (up from 310), 7 skipped, same
2 pre-existing `test_conform_engine.py` failures from Iterations 76-83
(unrelated, out of scope).

**Gate.** Full companion pytest suite — passes except the 2 pre-existing,
unrelated Python-version failures already documented since Iteration 76.

**Still open.** This is the fourth instance of bug species #7 — after
`proxy_service.py`'s IMF proxy cache, `ocf_proxy.py`'s OCF clip proxy
cache, and `media_engine/proxy_engine.py`'s transcode-proxy cache. Species
#7 is now extremely well-covered across cache/proxy-writing subsystems
broadly; a follow-up scouting pass should strongly consider pivoting to
other bug species/files, or doing one final narrow check of any remaining
cache-writing code not yet covered (e.g. thumbnail/waveform caches
specifically, if still unconfirmed either way).

Commits: `9177200`.

## Iteration 91 — `avf_bridge.swift`'s `batchExtract()` used a plain `CMTimeValue -> Int` map as a callback identity key, silently dropping frames when two requests clamp to the same timestamp

**Why this file.** A scouting agent (background, non-user input) was
seeded with all ten established bug species and steered away from the
now-saturated proxy/preview-cache subsystem (species #7, found four
times) and away from a possible fourth `color_lut.py` finding (species
#10, found three times), toward other subsystems: session/state,
path/URL construction, timecode/frame arithmetic, EDL/FCPXML/OTIO
parsers, native bridges, and Electron IPC. It reported a bug in
`electron/native/avf_bridge.swift`, a standalone Swift script (compiled
via `swiftc`, not a Swift package/module) invoked as a subprocess by
`electron/native/media_engine.js` to extract stills/hero-frames via
`AVAssetImageGenerator`.

**The bug.** `batchExtract()` built an index map for matching each
`generateCGImagesAsynchronously(forTimes:)` completion-handler
invocation back to its originating request:
`var timeToIndex = [CMTimeValue: Int]()`, populated via
`for (i, nv) in times.enumerated() { timeToIndex[nv.timeValue.value] = i }`.
`frameTime(f, fps:)` is a pure function of the frame number, and multiple
`FrameSpec`s in one batch routinely clamp to the same frame number via
`min(..., maxF)` — e.g. several hero-frame offsets all landing on `maxF`
for a short clip — producing identical `CMTime` values and thus identical
dictionary keys. The last-write-wins construction left `timeToIndex`
holding only the *highest* colliding index for that key. Apple's
generator still invokes the completion handler once per element of
`times`, including duplicates, so `remaining` decrements to exactly 0 and
the continuation resolves normally with no error or timeout — but both
duplicate-time callbacks resolved `idx` to the same (higher) index via
`timeToIndex[reqT.value] ?? 0`, both wrote `out[idx] = entry` (one
harmlessly overwriting the other with equivalent content), and the lower
colliding index's slot in `out` was never written — it stayed the empty
placeholder `{}` from `out`'s initialization
(`[[String: Any]](repeating: [:], count: count)`), with no `ok`, `label`,
`error`, or `dataUrl` key at all.

**Independent verification.** Read the full relevant source: the
`Command`/`FrameSpec` Decodable structs, `tcToFrame`, `frameTime` (a pure
function confirming identical inputs always produce identical `CMTime`
values), `handleGetStill`/`handleGetStills` (both delegate to
`batchExtract`), and the complete `batchExtract()` body including the
dictionary construction and the completion-handler closure. Confirmed
there is no existing test/CI coverage of this file at all — `npm test`
only runs Node parser/pipeline/color tests, `tests-js/*.test.mjs`, and
Python companion pytest; `avf_bridge.swift` is a standalone script with no
harness. Built and ran an end-to-end reproduction against a synthetic
8-frame/8fps ffmpeg test clip (`maxF = 7`), sending a `getStills` request
with frame values `[0, 20, 5, 999, 6]` (`20` and `999` both clamp to `7`)
against a pre-fix binary compiled straight from the unmodified source:
the response's second entry (label `"b"`, requested frame `20`) came back
as a completely bare `{}` — no `ok` key, no `label` key, nothing —
confirming the exact failure mode. Concrete downstream impact: any
`getHeroFrames`/`getStills` batch request on a short clip where several
distinct-labeled offset requests clamp to the same `maxF` produces a
`frames` array whose length matches the request count but with one or
more bare `{}` slots, breaking any consumer in `media_engine.js` or the
renderer that assumes every element has an `ok`/`label` key — likely a
silently blank/broken thumbnail tile, or a crash on `frame.error.*`
against a slot with no `error` key either.

**The fix.** Replaced the single-`Int`-valued map with a per-key queue of
indices, `var timeToIndices = [CMTimeValue: [Int]]()`, populated via
`timeToIndices[nv.timeValue.value, default: []].append(i)` so a colliding
`CMTimeValue` retains every index that mapped to it instead of just the
last one written. In the completion handler, each invocation pops one
index off its key's queue (`indices.removeFirst()`) under the same
`NSLock` already guarding `out`/`remaining` — necessary because Apple's
completion handler can fire concurrently across multiple threads and the
queue mutation must be atomic. Each of the `N` callback invocations for a
duplicated `CMTimeValue` now claims a distinct index, so every requested
frame gets its own populated `out` slot regardless of clamping
collisions.

**Test approach.** No existing Swift/native test harness exists in this
repo for `avf_bridge.swift` (no Swift Package, no XCTest target — it is a
free-standing script built via `swiftc` directly in `package.json`'s
`build:avf`/`build:avf:arm64` scripts). Verified via a manual end-to-end
binary test instead: generated a synthetic 8-frame, 8fps, 64x64 clip via
`ffmpeg -f lavfi -i testsrc=size=64x64:rate=8:duration=1 -pix_fmt yuv420p`
(confirmed via ffprobe: `r_frame_rate=8/1`, `nb_read_frames=8`, giving
`maxF=7`), then sent a `getStills` request with frame values
`[0, 20, 5, 999, 6]` — two of which (`20`, `999`) clamp to the shared
`maxF=7` — via stdin to a compiled binary, asserting every response entry
has an `ok` key and that labels match the original request order.

**Verification.** Pre-fix binary (compiled straight from unmodified
`avf_bridge.swift` via `git stash`): entry index 1 (label `"b"`, the
first of the two colliding requests) came back as a bare `{}` with no
`ok`/`label` key — confirmed genuine reproduction of the exact reported
mechanism. Restored the fix via `git stash pop`, confirmed via
`git diff --stat -- electron/native/avf_bridge.swift` that only the
intended 18-insertion/4-deletion fix diff was restored, rebuilt, and
reran the identical request: all 5 entries came back with `ok: true` and
correctly matching labels (`a`, `b`, `c`, `d`, `e`), including both
colliding requests (`b`→frame 7, `d`→frame 7) now resolving to distinct,
independently-populated output slots. `swiftc -typecheck` and a full
`swiftc` build both succeed cleanly. Full companion suite:
`python3 -m pytest -q` — 313 passed, 7 skipped, same 2 pre-existing
`test_conform_engine.py` failures from Iterations 76-83 (unrelated,
out of scope) — expected to be unaffected by a pure Swift/native change,
and confirmed so.

**Gate.** Manual end-to-end binary verification (pre-fix reproduction +
post-fix confirmation), since no automated harness exists for this file;
full companion pytest suite unaffected.

**Still open.** This is an eleventh, genuinely new bug species —
"non-unique key used as an identity map" in batch async-callback
dispatch — distinct from the ten previously catalogued. No automated
regression test was added to the repo for this fix, since there is no
existing Swift/native test harness or CI wiring to hang one on (`npm test`
does not touch `avf_bridge.swift`); a follow-up could establish a minimal
one (e.g. a small shell/JS script that builds the binary and exercises it
against a checked-in tiny fixture clip) if this bridge accumulates more
fixes. A follow-up scouting pass should also check whether the separate
`electron/native/PFXNativeMediaEngine/` Swift package (a distinct,
unexplored Swift Package with its own `MediaEngine.swift`,
`ThumbnailGenerator.swift`, etc.) is actively used and, if so, whether any
of its batch-dispatch code shares this same pattern.

Commits: `fe1d2c1`.

## Iteration 92 — `PFXNativeMediaEngine`'s `probeAsset()` truncated `duration * fps` instead of rounding, silently reporting one frame fewer than a clip actually has

**Why this file.** Iteration 91's "Still open" section flagged
`electron/native/PFXNativeMediaEngine/` — a separate, actively-used Swift
Package (confirmed via `grep` against `pfx_native_engine.js`, `ipc.js`, and
`preload.js`; it is wired into the desktop app's native media path, not
dead code) — as an unexplored follow-up target after finding a new bug
species in the sibling `avf_bridge.swift` bridge. A scouting pass over this
package's `MediaEngine.swift` surfaced a distinct issue in `probeAsset()`
(lines 280-321), the function every session-open and probe call routes
through to compute `MediaInfo`, including `frameCount`.

**The bug.** `probeAsset()` computed the clip's frame count as:

```swift
let durationSec = CMTimeGetSeconds(dur)
let frameCount  = fps > 0 ? Int(durationSec * fps) : 0
```

`CMTimeGetSeconds` converts the asset's rational `CMTime` duration
(`value`/`timescale`) to a `Double`, and `fps` is likewise a `Double`
conversion of the track's rational `nominalFrameRate`. Multiplying two
independently-rounded doubles that are mathematically supposed to produce
an exact integer routinely lands a hair under the true boundary instead of
exactly on it — e.g. `119.99999999999999` instead of `120.0` — because the
rounding errors in the two conversions don't cancel out. `Int(...)`
truncates toward zero, so `119.99999999999999` becomes `119`: one frame
short of the clip's actual, whole-frame length. This is most visible on
non-integer timebases like `30000/1001` (29.97fps) and `24000/1001`
(23.976fps), which are exactly the timebases most common in real-world
broadcast and film delivery.

**Independent verification.** Confirmed the exact buggy code by reading
`MediaEngine.swift` lines 280-321 directly. Confirmed the sibling function
`tcToFrame(_:fps:)` (lines 388-392) already gets this right — it uses
`Int(fps.rounded())` rather than truncating — establishing that
`probeAsset()`'s truncation was an inconsistency, not an intentional
choice: two functions in the same file take opposite stances on
rounding vs. truncating the same kind of fps-derived value. Confirmed via
`grep` two downstream consumers of `frameCount` as a seek-clamp upper
bound (`playbackSeek`, lines 140 and 142):
`s.state.frame = max(0, min(f, s.info.frameCount - 1))` and
`s.state.frame = max(0, min(Int(t * s.info.fps), s.info.frameCount - 1))`
— so an off-by-one-low `frameCount` makes the clip's true last frame
permanently unreachable via seek (and via any playback/thumbnail path that
clamps against `frameCount - 1`), not just a cosmetically wrong number in
a UI label.

Also independently reproduced the exact failure numerically before
touching any code: `4004/1001` frames-of-duration-seconds computation
confirmed in Python that `CMTime(value: 120120, timescale: 30000)` (120
frames at 30000/1001fps, i.e. a real 4.004s/29.97fps clip) yields
`dur * fps == 119.99999999999999` in IEEE double arithmetic — truncating
to 119, rounding to the correct 120.

**The fix.** Round instead of truncate, matching `tcToFrame()`'s existing
convention:

```swift
let durationSec = CMTimeGetSeconds(dur)
let frameCount  = fps > 0 ? Int((durationSec * fps).rounded()) : 0
```

**Test approach.** No XCTest target is available for this package (its
own `Package.swift` comment notes "XCTest is unavailable with Command Line
Tools only"), so verification followed the same manual pre-fix/post-fix
binary-comparison discipline established in Iteration 91, adapted to this
package's HTTP-server architecture: build the release binary, start it,
`curl` a `media.probe` request against a real test clip, and read
`frameCount` back out of the JSON response — once against the pre-fix
binary (via `git stash` on just this file) and once against the post-fix
binary.

Built a genuine 120-frame, 64x64, `30000/1001`fps (29.97fps) `.mov` via
`ffmpeg` (`ffmpeg -f lavfi -i testsrc=size=64x64:rate=30000/1001 -frames:v
120 ...`), confirmed via `ffprobe` as exactly `duration=4.004000,
nb_frames=120, r_frame_rate=30000/1001` — a real, unremarkable delivery
clip, not a contrived edge case.

**Verification.** Pre-fix binary (`git stash -- MediaEngine.swift`, `swift
build -c release`, run, `curl /command` with `media.probe`): response
included `"frameCount":119,"fps":29.970029830932617,"duration":
4.0039999999999996` — reproducing the exact reported bug against a real
120-frame clip. Post-fix binary (`git stash pop`, rebuild, same request):
response included `"frameCount":120` — the correct value — with `fps` and
`duration` unchanged, confirming the fix is isolated to the rounding
change and doesn't perturb anything else the response depends on. `swift
build -c release` succeeds cleanly on the restored fix (pre-existing
warnings only, no new ones). Full companion suite: `python3 -m pytest -q`
— 313 passed, 7 skipped, same 2 pre-existing `test_conform_engine.py`
failures from Iterations 76-83 (unrelated, out of scope) — expected to be
unaffected by a pure Swift/native change, and confirmed so.

**Gate.** Manual end-to-end HTTP-server binary verification (pre-fix
reproduction against a real 29.97fps clip + post-fix confirmation), since
no XCTest harness is available for this package; full companion pytest
suite unaffected.

**Still open.** This is a new instance of previously-catalogued bug
species #8 (truncation instead of rounding for a fractional-fps-derived
nominal/count value), but in a distinct conversion context from the
earlier instances (`duration * fps -> frameCount` here, vs. fps-to-nominal-
base conversions previously) — recorded as species #8 rather than a new
species, since the underlying defect (truncate vs. round on an
fps-derived double) is the same shape. No automated regression test was
added to the repo, for the same reason as Iteration 91: this package has
no XCTest target wired up (only a plain executable check harness,
`Tests/MediaStoreCheck`, aimed at the SQLite `PFXMediaCore` library, not
`MediaEngine`). A follow-up could add an XCTest target to this package's
`Package.swift` (Xcode.app's Swift toolchain, not just Command Line
Tools, would be required) if this package accumulates more fixes; until
then, `Tests/MediaStoreCheck`-style plain executable harnesses remain the
pragmatic option. `PFXNativeMediaEngine` has several other files not yet
individually examined for these bug species —
`ThumbnailGenerator.swift`, `WaveformGenerator.swift`, `ProxyCreator.swift`,
`RenderEngine.swift`, `HTTPServer.swift`, `IMFEngine.swift` — worth a
follow-up scouting pass.

Commits: `9a40200`.

## Iteration 93 — `imf_frame_provider.js`'s `decodeFrame()` keyed its preview cache on raw `displayMode`, ignoring `lowres` — letting a low-res scrub request silently return a stale/mismatched full-res frame

**Why this file.** `electron/imf/imf_frame_provider.js` implements the
primary FFmpeg-IMF-demuxer decode path for IMF package preview frames,
alongside a peer decode path (`requestFrame()`/`_cacheHit()` in the same
file) and the on-disk cache layer (`electron/imf/imf_cache.js`). Cross-
referencing every cache-key call site against every cache-read call site
in a single module is exactly the kind of quiet, one-file inconsistency
that survives a long time in the wild — nothing else in the codebase
depends on it being wrong, and it only diverges under the specific
low-res-scrub condition.

**The bug.** `IMFPreviewCache` supports a compound "variant" key
(`framePath`/`get(packageHash, cplId, mxfFrame, variant, ext)`), and
`_safeVariant()` in `imf_cache.js` deliberately preserves `.` characters
in that key specifically so values like `"sdr.lr2"` survive sanitization
— confirming the cache layer was designed, from the start, to support a
`"<displayMode>.lr<lowres>"` compound key. `requestFrame()`/`_cacheHit()`
in this same file already build that key correctly via a local
`_cacheMode(displayMode, lowres)` helper. `decodeFrame()`, the other
consumer of the same cache, did not: its cache-read
(`cache.get(packageHash, cplId, frameNumber, displayMode)`) and its
cache-write (`cache.framePath(packageHash, cplId, frameNumber,
displayMode)`) both used the raw `displayMode` string, silently dropping
the `lowres` discriminator. Concretely: a full-res decode
(`lowres: 0`) persists a frame at key `"sdr"`; a subsequent low-res
scrub-preview decode (`lowres: 2`) for the *same* frame number reads
that same `"sdr"` key, finds it, and returns the full-res image as if it
were the requested low-res one (`fromCache: true`) — and conversely, once
a low-res-tagged decode overwrites that slot (impossible here since the
key collides identically, but the direction that matters is: any first
writer at `"sdr"` locks all later requests, of any lowres level, into
that entry). The net effect for a user: switching between playback
(low-res-scrub) and full-quality-preview does not always route to a
correctly-sized decode — it can silently return the wrong resolution for
that frame until the cache entry ages out or the frame number moves on.

**Independent verification.** Traced every `cache.get`/`cache.framePath`
call site in `imf_frame_provider.js` (`requestFrame()`'s `_cacheHit()`
helper, `decodeFrame()`'s two sites, and a poster-frame lookup) and
confirmed `_cacheMode()` is the file's own established, working pattern
for this exact purpose — `decodeFrame()` is the only call site that
omits it. Read `imf_cache.js` in full to confirm `_safeVariant()`'s
comment ("keeps '.' so legitimate variant keys such as 'sdr.lr2' survive")
is not incidental — the cache layer was explicitly built to carry this
compound key.

**The fix.** In `decodeFrame()`: `const cmode = _cacheMode(displayMode,
lowres);` computed once, immediately before the cache-read
(`cache.get(packageHash, cplId, frameNumber, cmode)`), and reused at the
cache-write site (`cache.framePath(packageHash, cplId, frameNumber,
cmode)`) — matching the pattern already used by `_cacheHit()` in the same
file exactly.

**Test approach.** No existing test harness covers this module (Electron
main-process code with a hard `require('electron')` dependency used only
for `app.getPath('userData')`). Wrote a standalone Node script that
requires the real module directly and drives `decodeFrame()` against a
synthetic package/CPL, pre-populating the on-disk cache to simulate a
prior full-res decode, then requesting the same frame at `lowres: 2` and
asserting the response is *not* `fromCache: true`.

First attempt at this harness gave a **false pass in both the pre-fix and
post-fix case** — worth recording since it's a genuine trap for this
kind of test. Two separate causes had to be found and fixed before the
harness was trustworthy: (1) the fake `cplPath` initially didn't exist on
disk, tripping `decodeFrame()`'s early `CPL_NOT_FOUND` gate before the
cache-check code ever ran — fixed by writing a real (dummy-content) file
to that path; (2) the project's own installed `node_modules/electron`
package (a plain string path, not `{app}`, since it's a native-binary
launcher, not a real Electron runtime) always wins Node's normal module
resolution over an `NODE_PATH`-based stub, so `app.getPath('userData')`
throws inside `_ensureCache()` and it silently falls back to bare
`os.tmpdir()` as the cache base directory — not the subdirectory the
harness had pre-populated, so the cache read always missed regardless of
which code version was under test. Fixed by pointing the harness's
cache pre-population directly at that real fallback location
(`os.tmpdir()/PostFlowXCache/IMFPreview/...`) instead of fighting module
resolution.

**Verification.** With both harness bugs fixed: run against a confirmed
pre-fix copy of `decodeFrame()` (fix hunks manually reverted, sibling
file placed inside `electron/imf/` so its relative `require()`s still
resolve) — genuinely reproduced the bug: `{"fromCache": true, "ok": true,
"imagePath": ".../42_sdr.png"}` for the `lowres: 2` request, i.e. the
low-res request was wrongly satisfied by the full-res-only cache entry.
Run against the real, fixed `decodeFrame()` — `fromCache` absent, the
low-res request correctly missed the full-res-only cache entry and fell
through toward the real decode path (which then fails harmlessly on the
synthetic fake CPL with `PROBE_FAILED`, confirming the cache-check ran
and moved past it rather than short-circuiting on an unrelated gate).
Full regression: `npm run test:node` — 72 passed, 1 skipped (pre-existing
skip), 0 failed; `npm run test:js` — 47 passed (`tests-js/*.test.mjs`
suites), 0 failed. No regressions from an isolated 4-line change.

**Gate.** Genuine pre-fix-reproduction / post-fix-confirmation via a
standalone Node harness driving the real module directly (isolating
Electron's `app.getPath` dependency by targeting its real fallback
behavior rather than mocking it away), plus a clean full JS regression
run.

**Still open.** `cacheFrame()`/`_persistFrameToCache()` — the
renderer-to-main-process persist path used during continuous IMF
playback (`src/scripts/modules/imf/imf_player.js`) — also calls into this
cache using raw `displayMode` with no low-res discriminator. During
playback the renderer computes `decodeScale = S.isPlaying ?
(S.previewScale || 1) : 1` and can decode at a reduced scale for
real-time performance, then unconditionally calls
`_persistFrameToCache(frame, imageData)` regardless of whether that
decode was full-res or scaled-down — meaning a reduced-quality,
scaled-down frame decoded during scrubbing/playback can be persisted into
what should be the full-res cache slot for that frame number. This was
investigated this iteration and found to be architecturally distinct from
the `decodeFrame()`/`requestFrame()` discrete `lowres`-level system fixed
here — it's a continuous DWT-scale reduction mechanism with its own
`renderScale`/`decodeScale` split — so it was deliberately scoped out of
this fix rather than folded in. Flagging as a follow-up: either give the
renderer-side persist path its own scale-aware cache-key discriminator
(mirroring `_cacheMode()`), or gate `_persistFrameToCache()` so it never
writes while `decodeScale !== 1`.

Commits: `11b64c5`.

## Iteration 94 — `IMFEngine.swift`'s `seekFrame()`/`stepFrame()`/`grabThumbnail()` built their pfx-helper scratch-file path from only `packageId`+`frame`, letting two concurrent requests for the same frame clobber or delete each other's temp file

**Why this file.** Iteration 92's "Still open" section flagged several
files in `electron/native/PFXNativeMediaEngine/` — `ThumbnailGenerator.swift`,
`WaveformGenerator.swift`, `ProxyCreator.swift`, `RenderEngine.swift`,
`HTTPServer.swift`, `IMFEngine.swift` — as unexamined follow-up targets.
A scouting pass over these confirmed the first five are clean (correct
clamping in `ThumbnailGenerator.swift`, no fps/duration arithmetic in
`WaveformGenerator.swift`, correct `.rounded()` usage in
`ProxyCreator.swift`, standard floor-based frame-start semantics in
`RenderEngine.swift`, no cache/fps logic in `HTTPServer.swift`), but
surfaced a genuine defect in `IMFEngine.swift` — confirmed reachable in
production via `CommandRouter.swift`, which routes `imf.seekFrame`,
`imf.stepFrame`, and `imf.grabThumbnail` HTTP commands directly to these
three methods (not dormant/unwired code).

**The bug.** All three methods build a scratch file path for the
pfx-helper child process to write its decoded JPEG into, keyed on only
`packageId` and the current frame number:

```swift
let tmpPath  = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("pfx_native_\(packageId)_\(frame).jpg").path
```

Each method also accepts parameters that materially change what gets
written to that path — `seekFrame`'s `displayMode`/`outputWidth`,
`stepFrame`'s `direction`/`displayMode`/`outputWidth`, `grabThumbnail`'s
`width` — but none of those discriminators are folded into the filename.
`IMFEngine` is a plain class (not an actor), each command dispatches as
an independent `async` call with no lock guarding the temp-file path
itself, and the underlying `pfx-helper` writes happen out-of-process on
its own schedule. Two concurrent requests for the same `packageId`+
`frame` — e.g. an HDR full-res seek racing an SDR scrub-bar hover, both
landing while the user drags the timeline — collide on the identical
tmp path: whichever helper process finishes writing second clobbers the
first's bytes before the first request reads them back, and whichever
caller's `removeItem(atPath:)` runs first deletes the file out from
under the other. The result is either a caller silently receiving the
wrong request's frame image (wrong displayMode/resolution rendered) or
an `"output file not written"` / `"output file missing"` error thrown
for whichever request loses the race — this is the same "cache/identity
key discriminator dropped across call sites" shape as species #7
(Iteration 93's `decodeFrame()` cache-key bug), applied here to a
temp-file name instead of an in-memory/on-disk cache key.

**Independent verification.** Confirmed via direct reading of
`IMFEngine.swift` lines 147-286 that `seekFrame()`, `stepFrame()`, and
`grabThumbnail()` all share this exact pattern, and via
`CommandRouter.swift` lines 52-54 that all three are live HTTP command
targets (`case "imf.seekFrame": return try await imfEngine.seekFrame(...)`,
etc.), not unreferenced code.

**The fix.** Added a per-call `UUID().uuidString` suffix to each of the
three tmp-path constructions, guaranteeing every request gets its own
scratch file regardless of `displayMode`/`outputWidth`/`direction`/
`width`, matching the "give every concurrent variant its own identity"
principle already established in Iteration 93:

```swift
let tmpPath  = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("pfx_native_\(packageId)_\(frame)_\(UUID().uuidString).jpg").path
```

(and analogously for `pfx_step_...` and `pfx_thumb_...`).

**Test approach.** Exercising this end-to-end would require a real
IMF package decoded by the separate `pfx-helper` C++ binary
(`electron/imf/pfx-helper/`) — no such fixture package exists in this
repo, and fabricating an encrypted/real-world IMF asset purely to test a
temp-filename defect is out of scope. Since the defect lives entirely in
how `tmpPath` is constructed (and not in anything the helper process
itself does), the path-construction logic was extracted verbatim from
`IMFEngine.swift`'s pre-fix and post-fix `seekFrame()` forms into a
standalone Swift script and exercised directly against the exact race
described in the bug report: two concurrent "requests" for the same
`packageId`+`frame` but different `displayMode` (`"hdr"` vs. `"sdr"`),
modeling the real interleaving of two independent, lock-free pfx-helper
completions — request A writes, request B writes (landing before A
reads, since two child-process completions have no ordering guarantee),
A reads and deletes, B reads and deletes.

**Verification.** Pre-fix path construction (no UUID suffix, both
requests share one path): A's read-back returned `"sdr"` instead of its
own `"hdr"` bytes (A silently served B's frame data), and B's
subsequent read-back returned `"<missing>"` (A's `removeItem` had
already deleted the shared file) — reproducing both failure modes
described in the bug report against a real filesystem, not a mocked one.
Post-fix path construction (UUID-suffixed, distinct paths per request):
A read back `"hdr"` and B read back `"sdr"` — each request correctly
isolated from the other. `swift build -c release` succeeds cleanly on
`electron/native/PFXNativeMediaEngine` with the restored fix (pre-existing
warnings only — the known `NSLock` async-context warnings and a
no-op-`await` warning in `MediaEngine.swift`, both present before this
change, no new warnings introduced). Full regression suite: `npm run
test:node` 72/73 passed (1 pre-existing skip, 0 failed), `npm run
test:js` all suites passed (0 failed across the full `tests-js/*.test.mjs`
run), `python3 -m pytest -q` in `companion/` — 313 passed, 7 skipped,
same 2 pre-existing `test_conform_engine.py` failures from Iterations
76-83 (unrelated `int.bit_count()` Python-version issue, out of scope) —
all confirming this native Swift-only change perturbs nothing else.

**Gate.** Extracted-logic standalone-script verification (pre-fix
reproduction of both described failure modes + post-fix confirmation),
since no XCTest target exists for this package (consistent with
Iterations 91-92) and no real IMF/pfx-helper fixture exists to exercise
the methods end-to-end; full Node/JS/Python regression suites unaffected.

**Still open.** New instance of previously-catalogued species #7
(cache/identity-key discriminator dropped across call sites of "the same
resource"), here applied to temp-file naming rather than an in-memory or
on-disk cache key — recorded as species #7 rather than a new species,
since the underlying defect shape (a discriminating parameter silently
omitted from an identity/path key) is the same. No automated regression
test was added to the repo, for the same reason as Iterations 91-92:
`PFXNativeMediaEngine` has no XCTest target wired up. This closes out
the full list of `PFXNativeMediaEngine` files flagged in Iteration 92's
"Still open" section (`ThumbnailGenerator.swift`, `WaveformGenerator.swift`,
`ProxyCreator.swift`, `RenderEngine.swift`, `HTTPServer.swift`,
`IMFEngine.swift` — all now examined). The renderer-side
`_persistFrameToCache()` follow-up flagged in Iteration 93 remains open
and is a candidate for a future iteration.

Commits: `1fd7c04`.

## Iteration 95 — `imf_frame_provider.js`'s `decodeFrame()` built its own ffmpeg scratch-file path from only `packageHash`+`frameNumber`, letting two concurrent requests for the same frame clobber or delete each other's temp file

**Why this file.** Iteration 94 fixed the same defect shape
(`packageId`+`frame`-only temp-file naming, no request-identity
discriminator) in `IMFEngine.swift`'s pfx-helper scratch-file paths, and
flagged that the codebase's other frame-extraction paths were worth a
second pass. `imf_frame_provider.js`'s `decodeFrame()` is the sibling
ffmpeg-based decode path in the same feature area (distinct from the
Swift/pfx-helper path fixed in Iteration 94, and distinct from the
in-memory/on-disk preview cache fixed in Iteration 93) — a natural place
to check for the identical mistake made independently in a different
language and subsystem.

**The bug.** `decodeFrame()` computes `cmode = _cacheMode(displayMode,
lowres)` early and uses it correctly for both the cache read and the
cache write (the Iteration 93 fix). But its own temp ffmpeg output path —
`outPath`, the file ffmpeg is told to write to and that is later copied
into the cache and deleted — was built as `pfx_imf_${packageHash}_fr
${frameNumber}.png`, using neither `cmode` nor any other per-request
discriminator. Two concurrent `decodeFrame()` calls for the same
`packageHash`+`frameNumber` (e.g. a full-res preview request and a
low-res scrub request racing each other, or simply two overlapping
requests for the same frame from different UI triggers) resolve to the
identical `outPath` on disk. Whichever ffmpeg process finishes writing
last wins: the other request's `fs.copyFileSync(outPath, cachePath)` then
reads back the winner's data instead of its own, silently caching the
wrong resolution/mode under its own cache key. Worse, both requests race
to `fs.unlinkSync(outPath)` in their own cleanup — the first to run
deletes the file out from under the second, which then throws (swallowed
by the surrounding `try {} catch {}`) or, in the narrower timing window,
deletes the file the *other* request has not yet copied from, causing
that request to persist nothing into cache and fall back to reporting a
decode as if it succeeded with stale/no image data.

**Independent verification.** Read `imf_frame_provider.js` lines
955-1010 directly: confirmed `cmode` is computed once, used at the two
cache call sites (`cache.get(...)`, `cache.framePath(...)`), and never
referenced by `outPath`'s construction. Confirmed production-reachability
via the documented IPC call chain: `electron/preload.js` exposes the IMF
decode IPC, `electron/ipc.js` routes it to this module's `decodeFrame()`,
and `src/scripts/modules/imf/imf_player.js`'s `_tryElectronImfDecode()`
is the renderer-side caller that can issue overlapping requests for the
same frame during scrub/playback-mode transitions — the same call
pattern that made Iteration 93's cache-key bug user-visible.

**The fix.** Suffixed `outPath` with a per-call
`require('crypto').randomUUID()` — mirroring Iteration 94's Swift
`UUID().uuidString` fix exactly, and matching the established
`crypto.randomUUID()` idiom already used elsewhere in this codebase
(`src/scripts/prep_mark.js`, `src/scripts/features/vfxPull/
fdlGenerator.js`, `src/scripts/core/shotWorkItems.js`). This guarantees
every concurrent `decodeFrame()` call gets its own scratch file
regardless of `packageHash`/`frameNumber`/`cmode` collisions, so no two
requests can read back or delete each other's data. A one-line change;
the cache-key logic (`cmode`) is untouched since it was already correct.

**Test approach.** Same constraint as Iteration 93/94: no test harness
can exercise `decodeFrame()` end-to-end without a real ffmpeg IMF
demuxer and real IMF/MXF package fixtures, and reproducing the actual
race window through the real ffmpeg child-process path is not
deterministic. Extracted the exact vulnerable path-construction and
read-back/cleanup logic verbatim (pre-fix and post-fix forms) into a
standalone Node script that simulates two concurrent "requests" for the
same frame each writing distinct content to what the pre-fix code would
compute as an identical `outPath`, copying it to their own distinct
per-request cache slot, then deleting it — mirroring the real function's
copy-then-unlink sequence exactly.

**Verification.** Pre-fix (`old` mode, shared path): request A's copy
silently reads back request B's content instead of its own, and request
B's copy fails with the file already deleted by A's cleanup race — exit
code 1, both failure modes reproduced in one deterministic run. Post-fix
(`new` mode, UUID-suffixed path): request A and request B each read back
only their own content, no cross-contamination or missing-file error —
exit code 0. Full regression suite confirmed unaffected: `npm run
test:node` — 72 passed, 1 skipped (pre-existing), 0 failed; `npm run
test:js` — all `tests-js/*.test.mjs` suites passed, 0 failed; `python3 -m
pytest -q` in `companion/` — 313 passed, 7 skipped, the same 2
pre-existing `test_conform_engine.py` `int.bit_count()` failures from
Iterations 76-83 (unrelated Python-version issue, out of scope) — all
confirming this one-line JS-only change perturbs nothing else.

**Gate.** Extracted-logic standalone-script verification (pre-fix
reproduction of both described failure modes + post-fix confirmation),
since no real IMF/ffmpeg fixture exists to exercise `decodeFrame()`
end-to-end and the actual race window is not deterministically
reproducible through the real child-process path; full Node/JS/Python
regression suites unaffected.

**Still open.** Third confirmed instance of species #7 (a discriminating
identity/cache/path key silently dropped or inconsistent across call
sites of "the same resource") — now spanning three independent
subsystems in the same feature area: Iteration 93's in-memory/on-disk
cache key, Iteration 94's Swift pfx-helper temp-file path, and this
iteration's ffmpeg temp-file path, all in the IMF frame-decode pipeline.
No automated regression test was added to the repo, for the same reason
as Iterations 93/94: the vulnerable code path requires infrastructure
(Electron's `app`, a real ffmpeg IMF demuxer) not available to the
existing `test/`/`tests-js/` harnesses. The Iteration 93 "Still open"
follow-up (`_persistFrameToCache()`'s renderer-side scale-unaware cache
writes) remains open and untouched by this change.

Commits: `2cd24af`.

## Iteration 96 — OCF decode's `_decode_avf`/`_decode_ffmpeg`/`_decode_proxy_frame`
and `resolve_decode_frame()` built their scratch/lookup filename from only
`clip_path`+`frame_number`, letting two concurrent requests for the same
frame at different scales clobber or misread each other's output

### Why this file
Following up on the fifth confirmed instance of the "discriminating
identity/cache/path key silently dropped across call sites of the same
resource" species (species #7 — see Iterations 93, 94, 95), a background
scouting pass was pointed at subsystems outside the IMF pipeline already
covered by those three iterations. It surfaced the OCF (on-camera-format)
decode engine, `companion/src/postflowx_companion/ocf_engine/`, which
independently reimplements the exact same pattern.

### The bug
`ocf_decode.py`'s `decode_first_frame()` is called with a `scale` parameter
(default 960, but callers — ultimately `api.py`'s `_ocf_engine_decode_frame`
IPC handler — pass through whatever scale the UI requested for a given
preview, e.g. a small thumbnail scale vs. a full-resolution export check).
That `scale` was accepted by all three concrete decode paths but silently
dropped when building the on-disk temp/cache filename:

```python
# _decode_avf / _decode_ffmpeg (ocf_decode.py)
out_path = str(_ensure_tmp() / f"{_stem(clip_path)}_frame_{frame_number:06d}.png")

# _decode_proxy_frame (ocf_decode.py) — lookup side of the same key
candidate = str(_OCF_TMP / f"{stem}_frame_{frame_number:06d}{ext}")

# resolve_decode_frame (ocf_resolve_bridge.py)
out_img = os.path.join(out_dir, f"pfx_ocf_{stem}_frame_{frame_number:06d}.png")
```

Two concurrent (or rapidly sequential) requests for the same `clip_path`+
`frame_number` but different `scale` — e.g. the UI drawing a fast low-res
scrub thumbnail while a full-resolution still is being generated for
export — resolve to the identical filename. Whichever finishes last wins:
the other caller either gets the wrong-resolution image silently reported
as success, or (worst case under `_decode_ffmpeg`'s `-y` overwrite flag) a
half-written file if the two writes race. `_decode_proxy_frame`'s lookup
path made this actively worse: it returns *any* previously cached file at
that key as a hit regardless of the scale that produced it, so a proxy
generated at scale 320 will be silently served back for a scale 1920
request without ever going through a decode engine.

### Independent verification
Read `ocf_decode.py` lines 70-169 directly (all three concrete decode
functions, plus the shared `_try_engine()` dispatcher) and
`ocf_resolve_bridge.py`'s `resolve_decode_frame()` (line 58) to confirm the
`scale` parameter is present in every function signature but absent from
every constructed path string. Read `api.py` lines 6744-6764
(`_ocf_engine_decode_frame`) to confirm production reachability: this is
the companion HTTP/IPC endpoint handler that extracts
`scale = int(request.get("scale") or 960)` straight from the request body
and passes it unmodified into `decode_first_frame()` → `_try_engine()` →
the vulnerable functions. No test coverage previously existed for this
specific interaction.

### The fix
Added a `_s{scale}` discriminator suffix to the constructed filename in
all four call sites (`_decode_avf`, `_decode_ffmpeg`, `_decode_proxy_frame`
in `ocf_decode.py`; `resolve_decode_frame` in `ocf_resolve_bridge.py`),
e.g. `f"{stem}_frame_{frame_number:06d}_s{scale}.png"`. Unlike the IMF
pipeline's pure scratch files (Iterations 94/95, fixed with a random UUID
since those paths are never re-read), these OCF paths are meant to be
re-findable/cacheable across calls for the same clip+frame+scale
combination — `_decode_proxy_frame` explicitly re-reads a previous
engine's output by filename — so the correct fix is widening the key with
the missing discriminator, not randomizing it away.

A second, distinct issue was noted but deliberately left out of scope:
`ocf_resolve_bridge.py`'s `_render_queue_still()` fallback path hardcodes
`FormatWidth: 1920, FormatHeight: 1080` and has no `scale` parameter at
all, so it ignores the requested scale entirely rather than colliding on
an unqualified key. That is a different bug (a request ignored, not two
requests conflated) and is left for a future iteration.

### Test approach
Production end-to-end testing of the OCF decode path is not available in
this environment (it requires real camera-original footage, the compiled
`avf_bridge` binary, and/or a running DaVinci Resolve instance with its
scripting API enabled). Verified the fix with a standalone script
reproducing the exact filename-construction logic from both files:
confirmed that two requests for the same `clip_path`+`frame_number` at
different `scale` values produced an identical key before the fix and
distinct keys after.

### Verification
```
PRE-FIX collision: True -> A001_C001_frame_000042.png
POST-FIX distinct: True -> A001_C001_frame_000042_s320.png vs A001_C001_frame_000042_s1920.png
```

### Gate
`python3 -m pytest -q` in `companion/`: 313 passed, 7 skipped, 2
pre-existing failures in `tests/test_conform_engine.py`
(`test_regional_distance_discards_six_worst_cells`,
`test_regional_hash_identical_frames_distance_zero`, both
`AttributeError: 'int' object has no attribute 'bit_count'` from
`conform_engine.py:738`) — unchanged from baseline, unrelated to this
change. `npm run test:node` and `npm run test:js` are unaffected since
this is a Python-only change; not re-run.

### Still open
`_render_queue_still()`'s hardcoded 1920x1080 fallback resolution
(ignoring `scale` entirely) is a distinct bug left for a future
iteration. `_decode_sdk()` (BRAW/RED/ARRI/Canon vendor SDKs) is currently
a stub that always falls through to ffmpeg, so it was not in scope for
this key-collision species.

Commits: `8846ceb`.

## Iteration 97 — `pfx:imf:decodeTestFrame`'s ffmpeg output PNG used a
static, non-request-scoped filename, letting concurrent decode-test
calls clobber or misread each other's frame

### Why this file
Continuing the sweep for species #7 instances outside the areas already
covered (Iterations 93-96 were the IMF frame-provider pipeline and the
OCF decode pipeline), a background scouting pass was pointed at
`electron/ipc.js` and other untouched IPC handlers/engines. It found a
sixth, more severe instance of the same species: the discriminator here
wasn't just dropped, it was entirely absent — the filename never varied
at all, regardless of caller-supplied `frameNumber` or `cplPath`.

### The bug
`electron/ipc.js`'s `pfx:imf:decodeTestFrame` handler (registered at
line 854) accepts a per-call `cplPath`, `assetMaps`, `frameNumber`, and
`scale`, but both branches that write the debug decode's ffmpeg output
wrote to a single hardcoded path:

```js
// MXF fallback branch (line 931)
const outputPng = path.join(require('os').tmpdir(), 'postflowx_imf_frame_000000.png');

// Primary IMF-demuxer branch (line 978)
const outputPng = path.join(os.tmpdir(), 'postflowx_imf_frame_000000.png');
```

The `000000` suffix is static text, not a formatted frame number — every
invocation of this handler, for any CPL, any frame, from any window,
races on the exact same file. Two concurrent invocations (a user
double-clicking the "Decode Test Frame" button, or two renderer windows
both exercising the IMF debug tool) can have one call's `ffmpeg -y`
overwrite the PNG while the other is mid-`fs.readFileSync()` on it
(line 941/985), producing a truncated read, or — more insidiously — a
completed read that silently returns the *other* call's frame image
labeled as this call's result.

### Independent verification
Read `electron/ipc.js` lines 851-990 directly to confirm both branches
construct and then read back the identical static path. Traced
reachability: `electron/preload.js:628-629` exposes
`window.pfxPlatform.imf.decodeTestFrame(args)` over IPC channel
`pfx:imf:decodeTestFrame`; it is invoked from the "Decode Test Frame"
button handler in `src/scripts/modules/imf/imf_ui.js:968` and again from
`src/scripts/modules/smart_engine_settings.js:125,444`
(`decodeTestFrame()` wired to a `click` listener on `decodeBtn`) — both
ordinary, user-clickable buttons in the IMF debug/settings UI, not
test-only code.

### The fix
Widened the filename with `process.pid`, the request's own
`frameNumber`, and a timestamp in both branches:
```js
path.join(os.tmpdir(), `postflowx_imf_frame_${process.pid}_${frameNumber}_${Date.now()}.png`)
```
This is a pure debug scratch file (read once immediately after writing,
then discarded — never re-looked-up by a later call the way the OCF
proxy cache is), so — like Iterations 94/95's fix, and unlike Iteration
96's — a call-scoped unique name is the right fix rather than widening a
cache key with a missing dimension.

### Test approach
Reproduced the filename-construction logic from both branches in a
standalone Node snippet, since the vulnerable path requires Electron's
`ipcMain`/a real ffmpeg IMF demuxer build not available to `test/`/
`tests-js/`.

### Verification
```
PRE-FIX collision (two concurrent calls, different frames): true -> .../postflowx_imf_frame_000000.png
POST-FIX distinct: true -> .../postflowx_imf_frame_25388_5_1785312873501.png vs .../postflowx_imf_frame_25388_42_1785312873501.png
```

### Gate
`npm run test:node`: 72 passed/1 skipped/73 total, 0 failed — matches
baseline. `npm run test:js`: 25 passed, 0 failed — matches baseline
(exit code 0). `electron/ipc.js` contains substantial pre-existing
uncommitted WIP unrelated to this fix (an `_activeWindow`/
`_ipcRegistered` re-registration guard, a Meechum OAuth flow, a
clipboard import, and other hunks); isolated the two intended hunks via
`git add -p`, verified via `git diff --cached` showing exactly the two
`outputPng` lines changed before committing. Python suite not re-run —
this is a pure Electron/JS change.

### Still open
`imfFfmpegBackend.extractFrame()`/`extractImfFrame()` themselves were
not audited for other static-path assumptions beyond the `outputPng`
argument passed in by this handler; a future iteration should check
whether other IMF/OCF debug-test IPC handlers in `electron/ipc.js` share
this static-filename pattern.

Commits: `527a6b8`.

## Iteration 98: `build_preview_proxy()`'s standalone-media `.part` temp file collided across concurrent sessions of the same source file

**Why this file:** `companion/src/postflowx_companion/proxy_service.py` is the
companion's transcode/proxy engine. It already has one correctly-fixed
instance of the "temp-file collision" species in `_transcode_worker_inner()`
(the CPL/IMF conform-proxy path), which made it worth checking whether the
sibling standalone-media preview path (`build_preview_proxy()`) got the same
treatment.

**The bug:** `build_preview_proxy(session_id, media_path, ffmpeg_path, ...)`
(line 2481) computes a cache key from only the file's path and mtime:

```python
preview_cache_key = hashlib.sha256(f"preview_proxy:{media_path}:{mtime}".encode()).hexdigest()[:20]
cache_path = cache_dir / f"pfx_prev_{preview_cache_key}.mp4"
...
tmp_path = cache_path.with_suffix('.part')          # line 2572
```

and the codec-fallback path inside the same function, `_try_ffmpeg_direct()`,
duplicates the identical pattern:

```python
_tmp = cache_path.with_suffix('.part')              # line 2680
```

Neither `tmp_path` nor `_tmp` includes `session_id` — so two concurrent
`build_preview_proxy` calls for the *same* `media_path` (same mtime) resolve
to the exact same `cache_path` and the exact same `.part` temp file. Both
ffmpeg subprocesses write to that one path with `-y` (overwrite), and both
finalize via `os.replace(tmp_path, cache_path)` — an interleaved-write/racing-
rename that can leave `cache_path` truncated, corrupted, or momentarily
missing while the loser's `os.replace` races the winner's.

This is species #7 (a discriminating identity/cache/path key silently dropped
or inconsistent across call sites of "the same resource") — the sibling
worker in the very same file, `_transcode_worker_inner()` (line 3507), already
avoids this exact bug:

```python
out_path = cache_path.with_name(f".{cache_path.name}.{session_id}.part")
```

`build_preview_proxy()`'s standalone-preview path was simply never given the
same treatment.

**Independent verification:** Read `proxy_service.py` lines 2481-2710 directly.
Confirmed the cache-key/cache-path construction at lines 2496-2502, the
un-scoped `tmp_path` at line 2572, and the duplicate un-scoped `_tmp` at line
2680 inside `_try_ffmpeg_direct()`. Confirmed the finalize step at line 2880
(`os.replace(str(tmp_path), str(cache_path))`) and the equivalent in
`_try_ffmpeg_direct()` at line 2699. Confirmed the already-fixed sibling
pattern in `_transcode_worker_inner()` at line 3507. Traced reachability: the
only production caller is `api.py`'s `_build_media_proxy()` (line 1661),
which mints a fresh `session_id = uuid.uuid4().hex[:16]` per call (line 1686)
with **no de-duplication check** against an in-flight build for the same
`assetId`/`media_path`, and spawns `build_preview_proxy` on a brand-new daemon
thread every call (line 1697) — so nothing in this call path prevents two
overlapping calls (e.g. a UI double-click, or a rapid "Force ffmpeg" retry
while the first build is still running) for the same source file from racing
on the identical temp path.

**The fix:** Applied the same `session_id`-scoped naming already used by
`_transcode_worker_inner()` to both call sites in `build_preview_proxy()`:

```python
tmp_path = cache_path.with_name(f".{cache_path.name}.{session_id}.part")   # line 2572
...
_tmp = cache_path.with_name(f".{cache_path.name}.{session_id}.part")      # line 2680
```

`session_id` is already an in-scope parameter of `build_preview_proxy()` (and
therefore of the nested `_try_ffmpeg_direct()` closure), so no signature
change was needed. `cache_path` itself (the final, non-temp destination) is
left untouched — the cache-hit/cache-reuse semantics on `media_path`+`mtime`
are intentional and correct; only the *in-progress* temp file needed the
per-session widening, matching the pattern this file already established
elsewhere.

**Test approach:** Standalone reproduction script simulating the pre-fix and
post-fix path construction for two distinct `session_id`s against the same
`media_path`/`mtime`: pre-fix, `cache_path.with_suffix('.part')` produced the
identical path for both sessions (collision confirmed); post-fix, the
session-scoped name produced two distinct paths. `python3 -m pytest -q` in
`companion/` run before and after the edit.

**Verification:** `git diff -- proxy_service.py` showed exactly the two
intended one-line hunks (lines 2572, 2680), no pre-existing unrelated WIP and
no mode-bit drift on this file. `python3 -c "ast.parse(...)"` confirmed valid
syntax. `python3 -m pytest -q` in `companion/`: 313 passed, 7 skipped, 2
pre-existing failures in `test_conform_engine.py`
(`test_regional_distance_discards_six_worst_cells`,
`test_regional_hash_identical_frames_distance_zero`, both
`AttributeError: 'int' object has no attribute 'bit_count'`) — matching the
confirmed baseline exactly, unrelated to this change.

**Gate:** Fix is minimal, matches an existing in-file precedent exactly, and
regression suite is unaffected. Landing.

**Still open:** The cache-hit path (line 2551) reuses any existing
`cache_path` file if it already has a video stream, regardless of which
session originally produced it — this is intentional (that's the whole point
of caching by content+mtime) and not part of this bug. Not investigated this
iteration: whether other standalone-file transcode paths in this module
(beyond `build_preview_proxy`) have similar un-scoped temp-file patterns.

Commits: `b9729bf`.

## Iteration 99: `_restore_running_proxy_session()`'s reattach loop could spin forever when a dead PID left a stale `.part` file behind

**Why this file:** `proxy_service.py` is the same file fixed in Iteration 98
and has already yielded six species-#7 (missing discriminating key) bugs
across the codebase this session. A background scouting agent, given the
full bug catalog and told to avoid duplicates, was asked to find one more
solid candidate; it flagged the sidecar-based session-restore path as an
area not yet audited for liveness-detection correctness.

**The bug:** `_restore_running_proxy_session()` reattaches the UI to a
still-running (or possibly dead) ffmpeg transcode after the companion server
restarts mid-job, using a JSON "sidecar" file written by the original worker
to recover `pid`, `partPath`, progress, etc. Both the initial gate and the
per-iteration loop check used the same fragile condition:

```python
# initial gate, line 478 (pre-fix)
if not (_is_pid_alive(pid) or part_path.exists()):
    return False
...
# _watch() loop check, line 540 (pre-fix)
if not (_is_pid_alive((current.get('pid') if current else None) or pid) or part_path.exists()):
    update_session(..., stage='failed', error='proxy_interrupted')
    return
```

Both treat "PID alive OR `.part` file exists" as evidence the job might
still be running. But a `.part` file surviving on disk is not evidence of
anything once the PID is confirmed dead — ffmpeg does not clean up its own
partial output file when it's killed, crashes, or is force-quit alongside
the companion process. Once the PID is dead, the leftover `.part` file
never disappears, `_is_pid_alive()` never becomes true again, and the `or
part_path.exists()` term keeps re-satisfying the "still might be running"
condition on every single iteration of the `while True:` polling loop
(`_watch()`, `time.sleep(0.5)` per iteration) — forever. The failure branch
that's supposed to declare `stage='failed', error='proxy_interrupted'` can
only fire if the `.part` file is *also* absent, which it never will be for
this scenario. The UI is left stuck at "Reattaching proxy transcode… N%"
indefinitely, with a daemon thread polling every 0.5s until the process
exits.

**Independent verification:** Read `proxy_service.py` lines 460-560 directly
and confirmed the scouting agent's quoted code matched the source
byte-for-byte at the reported line. Confirmed there is no mtime/size-growth
tracking anywhere in `_watch()` that could otherwise distinguish "a process
is actively appending to this file" from "this file was abandoned by a dead
process." Also identified that the same fragile pattern appears a second
time, at the initial gate (line 478), which the scouting agent's report did
not explicitly call out but which needed the identical fix to avoid leaving
the bug half-fixed. Traced production reachability through `api.py` lines
1003-1015: `_restore_running_proxy_session` has exactly one call site,
invoked when a proxy-status/playback-start request finds the expected cache
file missing — i.e. the realistic post-crash/post-force-quit-and-reopen
scenario the agent described.

Before deciding on a fix, checked whether `pid` is reliably populated in the
sidecar alongside `partPath` at every write site (grepped all
`_write_proxy_sidecar(...)` calls with `partPath=`): every one of them
(the throttled per-progress-tick write around line 3549-3559, and the
one-time post-spawn writes at lines 3719 and 3985) writes `pid=process.pid`
in the same call as `partPath=str(out_path)`. This confirms `pid` is a
reliable, co-written field whenever `partPath` is meaningfully populated —
so a confirmed-dead `pid` is trustworthy evidence the job is not running,
and `part_path.exists()` should never be allowed to override that.

**The fix:** At both sites, stop treating a merely-existing `.part` file as
proof of continued life when the PID is known and confirmed dead. The
`part_path.exists()` fallback is now only consulted when `pid` itself is
missing (an incomplete/older sidecar that never recorded a PID) — in every
other case, `_is_pid_alive()` is authoritative:

```python
# initial gate (post-fix)
if pid is not None and not _is_pid_alive(pid):
    return False
if pid is None and not part_path.exists():
    return False
```

```python
# _watch() loop check (post-fix)
watch_pid = (current.get('pid') if current else None) or pid
pid_confirmed_dead = watch_pid is not None and not _is_pid_alive(watch_pid)
pid_unknown_and_no_part = watch_pid is None and not part_path.exists()
if pid_confirmed_dead or pid_unknown_and_no_part:
    update_session(..., stage='failed', error='proxy_interrupted')
    _write_proxy_sidecar(..., state='failed', error='proxy_interrupted')
    return
```

**Test approach:** Wrote a standalone script (`/tmp/verify_iter99.py`) that
creates a sidecar file recording a guaranteed-nonexistent PID (`999999`)
alongside a real leftover `.part` file on disk, then calls
`_restore_running_proxy_session()` directly and inspects the resulting
session state after giving the `_watch()` daemon thread time to run at least
one poll iteration. Ran this against the pre-fix code (via `git stash` to
temporarily revert just this file) and again against the post-fix code.

**Verification:**
- Pre-fix: `restore attempted: True`; after 1.5s the session was still
  `stage='restored_running', done=False` — confirming the loop would spin
  forever exactly as diagnosed.
- Post-fix: `_restore_running_proxy_session()` now returns `False`
  immediately (the initial gate correctly refuses to attempt reattachment
  for a confirmed-dead PID), so `_watch()` never even starts — the caller in
  `api.py` surfaces a single, immediate `NOT_FOUND` error instead of an
  infinitely spinning "reattaching" state.
- `git diff -- proxy_service.py` showed exactly the two intended hunks
  (lines ~475-479 and ~539-548), no pre-existing unrelated WIP, no mode-bit
  drift on this file.
- `python3 -m py_compile` confirmed valid syntax.
- `python3 -m pytest -q` in `companion/`: 313 passed, 7 skipped, 2
  pre-existing failures in `test_conform_engine.py`
  (`test_regional_distance_discards_six_worst_cells`,
  `test_regional_hash_identical_frames_distance_zero`, both
  `AttributeError: 'int' object has no attribute 'bit_count'`) — matching the
  confirmed baseline exactly, unrelated to this change.

**Gate:** Fix directly closes the diagnosed infinite-loop path, is minimal
(condition-only change, no new state), and the regression suite is
unaffected. Landing.

**Still open:** If a sidecar is ever written with `pid=None` (an incomplete
write, or a hypothetical caller that doesn't yet know its own PID) alongside
a genuinely-in-progress `.part` file, the `part_path.exists()` fallback
still allows an indefinite reattach loop for that PID-less case — this is
judged acceptable because every current sidecar-write call site always
supplies `pid` alongside `partPath`, so the PID-less branch is defensive
rather than a currently-reachable code path. Not investigated this
iteration: whether `_watch()` should also track `.part` file mtime/size
growth as a secondary staleness signal independent of PID liveness (the
scouting agent's alternate, more conservative suggestion) — deferred as
unnecessary given the PID-liveness signal is already reliable per the
sidecar-write-site audit above.

Commits: `d9feb82`.

## Iteration 100: `decode_test_frame()` in `imf_decode.py` collided scratch-PNG paths across different IMF packages and preview scales

**Why this file:** `companion/src/postflowx_companion/media_engine/imf_engine/imf_decode.py`
implements the IMF (Interoperable Master Format) still-frame decode used by
the companion's `/api/imf/decode-test-frame` endpoint — the same species of
discriminator-drop bug already found and fixed six times previously across
`imf_frame_provider.js`, `IMFEngine.swift`, `ocf_decode.py`,
`ocf_resolve_bridge.py`, and `electron/ipc.js` made this file worth
re-auditing directly.

**The bug:** `decode_test_frame(cpl_path, assetmap_paths, frame_number,
scale)` computed its scratch output path as:
```python
out_file = frame_dir / f"imf_frame_{frame_number:07d}.png"
```
This key is keyed on `frame_number` alone — it ignores both `cpl_path` (which
IMF package/CPL the frame is being decoded from) and `scale` (the requested
preview resolution). `_ensure_frame_dir()` returns a single shared
`tempfile.gettempdir() / "postflowx_imf_frames"` directory, so any two
decode requests for the same frame number — from two different IMF
packages, or the same package at two different preview scales — write to
the identical `out_file` path. Since the endpoint is served by a
`ThreadingHTTPServer` with true per-request concurrency and no lock around
this call, two concurrent requests (e.g. a user scrubbing frame 0 across two
open IMF package tabs, or a scale-change re-request racing the prior
in-flight one) could interleave `subprocess.run` writes to the same file,
each returning the other's (or a torn) image as its own result.

**Independent verification:** Read the full 209-line `imf_decode.py` source
directly and confirmed line 34 matched the reported code exactly. Spawned a
dedicated Explore agent to independently confirm, with exact line-number
quotes, that (a) `decode_test_frame` has exactly one call site,
`http_server.py:621`, inside the `/api/imf/decode-test-frame` handler, and
(b) the server is constructed via `ThreadingHTTPServer` (`http_server.py:3`,
`818`, `831`) with no `threading.Lock` wrapping this code path — the
existing `_server_lock` and `_file_registry_lock` cover unrelated code.
Both claims confirmed independently.

**The fix:** Hash `cpl_path` into the filename and append `scale`, closing
both missing discriminators in one edit:
```python
cpl_hash = hashlib.sha1(cpl_path.encode("utf-8")).hexdigest()[:12]
out_file = frame_dir / f"imf_frame_{cpl_hash}_{frame_number:07d}_s{scale}.png"
```
(plus the corresponding `import hashlib`). An incidental `100644` →
`100755` mode-bit change introduced by the edit tool was caught via `git
diff` and reverted with `chmod 644` before staging, keeping the commit
scoped to the intended content change only.

**Test approach:** A full end-to-end repro would require real IMF package
assets and a working `ffmpeg`/`ojph_expand` toolchain, so — consistent with
the standalone-path-construction repro style used in Iterations 96-98 — a
standalone script (`/tmp/verify_iter100.py`) directly exercises the pre-fix
and post-fix path-construction logic for two different `cpl_path` values
requesting the same `frame_number`/`scale`.

**Verification:**
- Pre-fix: both packages produced the identical path
  `imf_frame_0000000.png` — confirmed collision.
- Post-fix: the two packages produced distinct paths
  (`imf_frame_578cc5a03acb_0000000_s960.png` vs.
  `imf_frame_f58317bb0efa_0000000_s960.png`) — confirmed distinct.
- `git diff -- imf_decode.py` showed exactly the two intended hunks (the
  `import hashlib` addition and the `out_file`/`cpl_hash` computation), file
  mode preserved at `100644`, no unrelated changes.
- `python3 -m py_compile` confirmed valid syntax.
- `python3 -m pytest -q` in `companion/`: 313 passed, 7 skipped, 2
  pre-existing failures in `test_conform_engine.py`
  (`test_regional_distance_discards_six_worst_cells`,
  `test_regional_hash_identical_frames_distance_zero`, both
  `AttributeError: 'int' object has no attribute 'bit_count'`) — matching
  the confirmed baseline exactly, unrelated to this change.

**Gate:** Fix directly closes both missing discriminators with a minimal,
additive change (no behavior change for the already-unique case), and the
regression suite is unaffected. Landing.

**Still open:** The three fallback decoders (`_try_ffmpeg_imf_demuxer`,
`_try_direct_mxf`, `_try_ojph`) still overwrite the same `out_file` in
sequence within a single call — this is intentional (only one fallback's
output should survive per call) and unaffected by this fix. Not
investigated this iteration: whether `_FRAME_DIR`'s scratch PNGs are ever
garbage-collected — the directory can accumulate one file per unique
`(cpl_path, frame_number, scale)` combination indefinitely, which was true
before this fix too (just under a collision-prone key) and is a separate,
pre-existing concern from the correctness bug fixed here.

Commits: `9634c1c`.

## Iteration 101: `generate_proxy()` in `ocf_proxy.py` had an unreachable 600s timeout — a stalled ffmpeg leaked its process and worker thread forever

**Why this file:** `companion/src/postflowx_companion/ocf_engine/ocf_proxy.py` implements
OCF (camera-original) proxy generation via ffmpeg, invoked asynchronously
from the `ocfGenerateProxy` HTTP endpoint. Given how many discriminator-drop
bugs had already been found and fixed this loop, this iteration's scouting
agent was explicitly asked to hunt for a *different* bug species —
concurrency, resource leaks, dead error handling, and similar — rather than
another cache-key variant.

**The bug:** `generate_proxy()` read ffmpeg's progress like this:
```python
proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
duration_s = _probe_duration(clip_path, ffprobe)
for line in (proc.stderr or []):
    if callback and "time=" in line:
        pct = _parse_progress(line, duration_s)
        callback(pct, line.strip())
proc.wait(timeout=600)
```
Iterating a pipe file object blocks on `readline()` until either a line
arrives or the pipe hits EOF — and the pipe only reaches EOF when ffmpeg
closes stderr, i.e. when the process exits. So the `for` loop cannot return
before ffmpeg terminates on its own; the `proc.wait(timeout=600)` on the
next line is unreachable as a timeout guard — by the time execution gets
there the process has already exited, or the loop is already blocked
forever with no timeout at all. The `except subprocess.TimeoutExpired:
"ffmpeg proxy generation timed out (>10 min)"` handler further down is dead
code for the actual hang scenario (a process that stops producing stderr
output without exiting), even though it correctly fires for the unrelated
case of `proc.wait()` itself timing out post-EOF.

**Independent verification:** Read the full file directly and confirmed
lines 70-79 matched the scouting report exactly. Spawned a dedicated Explore
agent to confirm every call site of `generate_proxy`/`generate_proxy_async`:
the only production caller is `generate_proxy_async` (`ocf_proxy.py:135`),
which always runs `generate_proxy` inside a `daemon=True` background thread
(`ocf_proxy.py:138`), reached via `api.py:6818`'s `ocfGenerateProxy` HTTP
handler. Confirmed `generate_proxy` is never called directly from an HTTP
request-handler thread — so the bug doesn't stall a request thread, but it
does leak the daemon thread and the orphaned ffmpeg child process
indefinitely, and leaves `_jobs[job_id]` stuck at `{"state": "running"}`
forever with no error, no timeout, and no way for the UI's
`ocfProxyJobStatus` polling to detect or recover from the stall. Realistic
trigger: a corrupt/malformed camera-original file (bad ARRIRAW/R3D wrapper,
malformed timecode atom) or a network-mounted OCF volume that stops
responding mid-encode — ffmpeg stops emitting progress lines without
exiting.

**The fix:** Replaced the blocking iteration with a deadline-aware
`select.select()` polling loop that actually enforces the 600s budget and
kills the process on expiry:
```python
deadline = time.monotonic() + 600
while True:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        proc.kill()
        proc.wait()
        raise subprocess.TimeoutExpired(cmd, 600)
    ready, _, _ = select.select([proc.stderr], [], [], min(remaining, 1.0))
    if not ready:
        continue
    line = proc.stderr.readline()
    if line == "":
        break
    if callback and "time=" in line:
        pct = _parse_progress(line, duration_s)
        callback(pct, line.strip())
proc.wait(timeout=max(0.1, deadline - time.monotonic()))
```
The existing `except subprocess.TimeoutExpired` handler now correctly
catches this manually-raised timeout too, so the job surfaces a real
"timed out" error instead of hanging forever. (Uses `select`, POSIX-only —
acceptable since this is a macOS-only companion app per its AVFoundation/
DaVinci Resolve native bridges.)

**Test approach:** A real end-to-end repro needing a stalled ffmpeg encode
of a corrupt camera file is impractical to automate reliably, so a
standalone script (`/tmp/verify_iter101.py`) demonstrates the underlying
mechanism directly: it spawns a real subprocess (`sleep 30`, a stand-in for
a hung encoder that never writes to stderr or exits) and runs both the
pre-fix loop shape and the post-fix loop shape against it inside a bounded
test window.

**Verification:**
- Pre-fix loop shape: still blocked after 3 real seconds despite the
  `proc.wait(timeout=600)` on the very next line — confirming the timeout
  is unreachable.
- Post-fix loop shape: with a 1.5s deadline, the worker thread observed the
  deadline, killed the process, raised `TimeoutExpired`, and finished
  within the 3s join window — confirming the timeout is now real and the
  process/thread are no longer leaked.
- `git diff -- ocf_proxy.py` showed exactly the intended hunks (new
  `select`/`time` imports plus the loop rewrite), file mode unchanged
  (already `100755` before this edit — pre-existing drift, not introduced
  here).
- `python3 -m py_compile` confirmed valid syntax.
- `python3 -m pytest -q` in `companion/`: 313 passed, 7 skipped, 2
  pre-existing failures in `test_conform_engine.py`
  (`test_regional_distance_discards_six_worst_cells`,
  `test_regional_hash_identical_frames_distance_zero`, both
  `AttributeError: 'int' object has no attribute 'bit_count'`) — matching
  the confirmed baseline exactly, unrelated to this change.

**Gate:** Fix makes the already-documented 600s timeout behavior actually
work, with no change to the success-path behavior (progress callbacks and
return values are unchanged for a normally-completing encode). Regression
suite unaffected. Landing.

**Still open:** The H.264 fallback path (`subprocess.run(cmd_h264,
capture_output=True, timeout=600)`, line 91) uses `subprocess.run`'s own
built-in timeout, which does *not* share this bug — `run()` internally uses
`communicate()`, which is deadline-aware and kills the process on timeout.
Not investigated this iteration: whether other companion-server subprocess
call sites use the same blocking-pipe-iteration pattern seen here (a
systematic audit of every `subprocess.Popen(..., stderr=PIPE)` call site
across `companion/` was out of scope for this single-bug iteration).

Commits: `6026143`.

## Iteration 102: `_extractEvents()` in `prproj.js` treated a genuine source-tick-0 `Out` value as "missing," silently substituting the wrong duration basis for freeze-frames

**Why this file:** A background scout was tasked with hunting for bug
species other than discriminator-drop. Its top candidate — a missing
`suggestedSourceOut` field in `conform_engine.py`'s visual-match candidate
builder — turned out to sit entirely inside a large (~455-line) pre-existing
*uncommitted* WIP feature ("Picture Conform v1.4" visual fingerprinting,
confirmed via `git diff --stat` on that file before touching it). Per this
loop's standing discipline of never grafting a partial fix onto in-progress
uncommitted work, that candidate was reverted untouched and a secondary
lead the same scouting pass had also surfaced — `src/scripts/parsers/prproj.js`
— was pursued instead, after confirming via `git diff --stat` /
`git log --oneline` that this file was fully clean and committed (only a
pre-existing mode-bit flip, no content changes).

**The bug:** `src/scripts/parsers/prproj.js:261-262`, inside `_extractEvents`
(the Adobe Premiere `.prproj` timeline parser):
```js
const srcInTick  = videoStartTick + (clipInTick  >= 0 ? clipInTick  : 0);
const srcOutTick = videoStartTick + (clipOutTick >  0 ? clipOutTick : (recEndTick - recStartTick));
```
`clipInTick` uses `>= 0` (zero is valid data) but `clipOutTick` uses `> 0`
(zero is treated as absent). A clip whose Premiere `Out` value genuinely
serializes as source tick `0` — e.g. a single-frame freeze held at the very
start of a source clip, extended out to fill a longer record duration on
the timeline — falls into the "missing" branch and gets `recEndTick -
recStartTick` (the *timeline* record duration in ticks) substituted for
the source-tick duration instead. Record duration and source duration are
different bases whenever there's a freeze, retime, or speed change, so
`srcOutTick`, and therefore the exported `srcOut` timecode
(`_ticksToTC(srcOutTick, ...)` at line 298), comes out silently wrong — no
error, no warning, just a corrupted source-out range feeding the
conform/EDL pipeline for that event.

**Independent verification (reachability):** A dedicated Explore agent
confirmed this is a real user-facing import path, not test-only code:
`ui.js` dynamically imports `parsePRPROJ` from this file and routes any
`.prproj` file dropped/picked by the user directly to it
(`parseFromFiles`), and `timelineFormats.js` registers `.prproj` in the
conform router's canonical extension set.

**The fix:** Made the guard symmetric, matching `clipInTick`'s existing
`>= 0` check:
```js
const srcOutTick = videoStartTick + (clipOutTick >= 0 ? clipOutTick : (recEndTick - recStartTick));
```

**Test approach:** No existing fixture exercises an `Out=0` clip, so a
synthetic gzip-XML `.prproj` fixture was built standalone
(`/tmp/freeze_test.prproj`) — a single `ClipItem` with `In=0`, `Out=0`,
`Start=0`, `End=2032128000` (a ~5-frame record hold at 24fps) — and run
through the real `parsePRPROJ()` entry point.

**Verification:**
- Post-fix: `srcIn` = `01:00:00:00`, `srcOut` = `01:00:00:00` — correct,
  the freeze holds at source tick 0 as encoded.
- Pre-fix (confirmed by temporarily reverting the guard via `sed` and
  re-running the same fixture, then restoring the fix): `srcOut` came out
  as `01:00:00:05` — the record-duration substitution bleeding into the
  source-tick domain, exactly the predicted failure mode.
- `git diff -- src/scripts/parsers/prproj.js` showed exactly the intended
  one-line hunk; the file's mode-bit flip (`100644` → `100755`) was
  confirmed pre-existing (present before this edit, 0 content diff) and
  left untouched per standing discipline.
- `npm run test:node`: 72 passed, 1 pre-existing skip, 0 failures —
  including the existing `test/parsers/prproj.test.mjs` golden test
  (unaffected since both its fixture clips have non-zero `Out` values).
- `npm run test:js`: 22 passed, 0 failed.
- `python3 -m pytest -q` in `companion/` (unaffected by a JS-only change,
  run for full-suite confidence): 313 passed, 7 skipped, the same 2
  pre-existing unrelated failures as every prior iteration's baseline.

**Gate:** One-character-class fix (`>` → `>=`) with no effect on any clip
whose `Out` value is genuinely positive — the entire existing golden
fixture and regression suite is unaffected. Landing.

**Still open:** The reverted `conform_engine.py` / `suggestedSourceOut`
finding remains a real, reachable bug (confirmed: it also produces a
malformed `00:00:00:00` `Out` timecode in EDL exports, and an unguarded
Resolve-timeline-append path with no `out > in` check) — but it lives
inside uncommitted WIP and should be fixed as part of that feature landing,
not grafted on separately. Two further unverified leads from the same
scouting pass were not pursued this iteration: an `electron/ipc.js`
`pfx:download` handler said to ignore the chosen save path and report
success before the download starts, and a possible non-atomic
direct-to-cache-path write in `r3d_backend.py`'s `_decode_frame_helper`
under concurrent prefetch.

Commits: `f0fcac6`.

## Iteration 103: `_decode_frame_helper()` in `r3d_backend.py` wrote the
## final encoded frame straight to its own cache-lookup path, letting a
## concurrent reader observe a truncated/partial JPEG mid-write

**Why this file:** `r3d_backend.py` is the RED R3D decode backend behind
full-quality frame previews. `_decode_frame_helper()` is the hot path any
time a `.r3d` clip is scrubbed or previewed at full resolution.

**The bug:** At line 673, `out_path = self._cache / f"{cache_key}.{fmt}"`
is both the final encoded-frame destination *and* the cache-hit check any
caller uses (`out_path.is_file() and out_path.stat().st_size > 0`, line
675). The intermediate raw decode buffer already used a proper
`tempfile.mkstemp(dir=str(self._cache))` + cleanup pattern, but the final
ffmpeg encode step had ffmpeg write its JPEG/PNG output directly to
`str(out_path)` with `-y` (truncate-and-write) — no temp file, no atomic
rename. Any thread checking the cache-hit condition while ffmpeg's write
was in flight could observe `out_path` as an existing, non-empty, but
incomplete/corrupt file.

**Independent verification (reachability):** A dedicated Explore agent
confirmed a genuine concurrent-access path, not a theoretical one:
`companion/.../http_server.py` runs a `ThreadingHTTPServer` (one thread
per request), and `ring_buffer.py`'s `PrefetchScheduler` independently
runs 2 worker threads that call `backend.get_frame()` for nearby frames
while the user scrubs. The in-flight dedup in the prefetch queue only
prevents double-scheduling *within* the prefetch queue — it does nothing
to stop a foreground HTTP request thread and a prefetch worker thread
from racing on the same `cache_key`/`out_path` for the same frame, which
is exactly what happens during timeline scrubbing near a frame the
prefetcher has also queued. `git diff --stat` on the file showed 0
content diff (only the pre-existing repo-wide mode-bit chmod drift) and
`git log --oneline` showed no uncommitted WIP touching this file — clean
to fix.

**The fix:** Mirrored the existing raw-buffer pattern for the encoded
output: added `enc_tmp` via `tempfile.mkstemp(suffix=f".{fmt}",
dir=str(self._cache))`, pointed both ffmpeg `cmd` invocations (ACES2 and
default-look branches) at `enc_tmp` instead of `str(out_path)`, changed
the post-encode success check to inspect `enc_tmp`, and added
`os.replace(enc_tmp, out_path)` for an atomic swap once encoding is
confirmed complete. Extended the existing `finally` cleanup block to also
unlink any leftover `enc_tmp` (e.g. on an ffmpeg failure before the
rename runs).

**Test approach:** A standalone harness (`/tmp/verify_r3d_atomic.py`) was
built to genuinely exercise the real, unmodified `_decode_frame_helper`
method — not just review the diff. It instantiates a real `R3dBackend`
pointed at an isolated temp cache dir, monkeypatches `_get_metadata_impl`
to skip the unrelated R3D-header/ffprobe/native-probe metadata layers,
and points `_helper` at a fake shell script (`/tmp/fake_r3d_helper.sh`)
that mimics the native decode helper's CLI contract (writes a raw BGRA
buffer + a JSON status line). A background watcher thread polls the
exact computed final cache path (`out_path`, using the same SHA-256
`cache_key` formula as the real code) every ~1ms, comparing file size
across a 3ms window, to detect any moment the file exists but is still
being written to.

**Verification:**
- Post-fix: decode succeeded and returned a valid result dict
  (`cacheHit: False`, non-empty `dataUrl`); the watcher recorded 11
  consecutive polls of the final cache file, every one at the same
  complete size (208 bytes) — the file never appeared in a partial state,
  because ffmpeg now writes to a distinctly-named `enc_tmp` file that the
  watcher (correctly) never matches until `os.replace` makes the complete
  file appear atomically under its final name. No leftover temp files
  remained in the cache dir afterward.
- Pre-fix (confirmed by temporarily reverting the temp-file/`os.replace`
  change via a scripted string-replace, re-running the identical harness,
  then restoring the fix from a backup copy): the watcher still did not
  catch a torn read on this run, because the test payload (16×16px, a
  208-byte JPEG) is small enough that ffmpeg's direct `-y` write to
  `out_path` completes faster than the ~1ms polling interval can reliably
  observe — flagged here explicitly rather than glossed over. The
  structural argument for the fix does not depend on reproducing the race
  under polling: pre-fix, ffmpeg's `-y` open is truncate-then-write, which
  by construction has a window (however narrow) where `out_path` exists
  at zero or partial length while a concurrent reader's cache-hit check
  could pass; post-fix, that window cannot exist for `out_path` at all,
  since nothing ever writes to it except the atomic `os.replace` of a
  fully-formed file.
- `python3 -m pytest -q` in `companion/`: 313 passed, 7 skipped, the same
  2 pre-existing unrelated failures as every prior iteration's baseline.
- `npm run test:node`: 72 passed, 1 pre-existing skip, 0 failed.
- `npm run test:js`: 22 passed, 0 failed.
- `git diff --stat -- companion/src/postflowx_companion/media/backends/r3d_backend.py`
  showed exactly 8 insertions / 3 deletions (the intended hunk) plus the
  pre-existing mode-bit flip; `electron/ipc.js` and `conform_engine.py`
  remained untouched in their prior WIP state.

**Gate:** Purely additive (new temp file + atomic rename around an
existing encode step); no change to cache-key derivation, decode
parameters, or any caller-visible return shape. Landing.

**Still open:** The `electron/ipc.js` `pfx:download` finding from
Iteration 102 remains real, reachable, and unfixed — abandoned again this
iteration because the exact handler lines (the `dialog.showSaveDialog` /
`downloadURL` calls) sit directly inside a 541-line uncommitted WIP diff
(the Meechum-OAuth `mainWindow` → `_activeWindow` rename) that touches
those same lines. This should be fixed as part of that WIP landing, not
grafted on separately. The `conform_engine.py` `suggestedSourceOut`
finding also remains open for the same reason.

Commits: `c706108`.

## Iteration 104

**Why this file:** `imf_qc.py` is the IMF QC/validation engine invoked by
`api.py`'s `_run_imf_qc()` and surfaced verbatim to the Electron/renderer
UI as the package's pass/fail verdict. A wrong `overallStatus` here is a
false report shown directly to the operator deciding whether to deliver
a package.

**The bug:** `run_photon()` always runs embedded-MIC verification
(`verify_essence_mic`) and essence-descriptor conformance
(`verify_essence_conformance`) independently of whether Netflix Photon
itself is available, and folds both into a `mic_findings` list. But the
function's `base` result dict hardcodes `"overallStatus": "fail"` at
construction time, and none of its four early-return branches — Java
missing, `photon.jar` missing, Photon timeout, Photon launch exception —
ever recompute that field from `mic_findings` before returning. Only the
successful-Photon-run path at the bottom of the function correctly
derives `overall` from combined `errors`/`warnings`. The practical
effect: any package with a completely clean embedded MIC and clean
essence-descriptor conformance, but where Java or `photon.jar` simply
isn't installed on the machine, is reported to the operator as a hard
QC **failure** — indistinguishable from a package with a real integrity
problem.

**Independent verification:** Read `run_photon()` directly
(`companion/src/postflowx_companion/imf_qc.py`, lines ~309-410) and
confirmed the exact structure a scout agent had flagged: the `base` dict
initializes `overallStatus` to `"fail"` (line ~330), `mic_findings` is
computed at line ~340 but only ever assigned to `base["findings"]`, never
used to correct `overallStatus`, in the `not java` / `not jar` /
`TimeoutExpired` / generic-exception branches (lines ~342-378). Confirmed
`_mic_findings()`/`_conform_findings()` both emit dicts with a
`"severity"` key using `"ERROR"`/`"WARNING"` (matching the vocabulary the
successful-run path already filters on at line ~395-396:
`f["severity"] in ("ERROR", "FATAL")` for errors, `"WARNING"` for
warnings). Confirmed reachability: `api.py`'s `_run_imf_qc()` calls
`run_photon` (aliased `_run_photon_qc`) and returns the result verbatim
via `self._ok(result)`, cached in `self._qc_cache` — no caller
recomputes `overallStatus`. Confirmed the existing
`test_imf_qc_mic.py::test_mic_attached_when_photon_absent` test exercises
the Photon-absent path with a clean MXF but only asserts on
`res["mic"]["overallStatus"]`, never on the top-level
`res["overallStatus"]` — leaving this bug uncaught. Confirmed via
`git diff --stat -- companion/src/postflowx_companion/imf_qc.py` and
`git log --oneline -5 -- <file>` that the file carried no pre-existing
uncommitted WIP before this fix (clean at HEAD `0a57b69`), so no
WIP-overlap risk.

**The fix:** Immediately after computing `mic_findings`, and before any
of the four early-return branches, compute `base["overallStatus"]` from
`mic_findings` severities using the same rule the successful-Photon-run
path already applies: `"fail"` if any finding has severity `"ERROR"` or
`"FATAL"`, else `"warn"` if any has `"WARNING"`, else `"pass"`. This
makes every return path — Photon available or not — report a status
that reflects what MIC/conformance actually found, instead of the four
early-return branches silently overriding a legitimately clean result
with the hardcoded `"fail"` default.

**Test approach:** Built a standalone harness
(`/tmp/verify_imf_qc_fix.py`) that imports `imf_qc` directly and
monkeypatches `find_java` (→ `None`, simulating Photon unavailable),
`verify_essence_mic`, and `verify_essence_conformance` to return
Photon-independent rollups shaped exactly like the real functions'
output (`results: []` for a clean MIC/conformance pair, matching what
`_mic_findings`/`_conform_findings` iterate over). Ran the harness
against the actual unmodified `run_photon()` before applying the fix (via
`git stash` on just this file) to confirm the bug reproduces: a
completely clean package with Photon unavailable returned
`overallStatus: "fail"`. Restored the fix (`git stash pop`) and re-ran
the identical harness: the same clean package now returns
`overallStatus: "pass"`. Added a second case in the same harness — a
dirty MIC (one `ERROR`-severity finding) with Photon still
unavailable — confirming the fix correctly still reports `"fail"` for a
genuinely broken package, i.e. this is not a blanket "always pass when
Photon is missing" regression.

**Verification:** Before-fix run: `overallStatus: fail` for the clean
case (bug reproduced). After-fix run: `overallStatus: pass` for the
clean case, `overallStatus: fail` retained for the dirty-MIC case — both
asserted in the harness with a nonzero exit code on failure; both passed
cleanly (exit 0) after the fix. Full regression suites re-run and
confirmed against the established baseline: Python
(`python3 -m pytest -q` in `companion/`) — 313 passed, 7 skipped, 2
failed (the same pre-existing, unrelated `test_conform_engine.py`
`bit_count()` failures documented in prior iterations); Node
(`npm run test:node`) — 72 passed, 1 skipped, 0 failed; JS
(`npm run test:js`) — 22 passed, 0 failed. `git diff --stat` on the
target file showed exactly the intended 10-line insertion (plus the
pre-existing repo-wide mode-bit drift, `100644`→`100755`, unrelated to
this change and consistent with every other file touched this session).

**Gate:** No caller of `run_photon()` relies on `overallStatus` staying
`"fail"` when Photon is unavailable — `api.py`'s `_run_imf_qc()` passes
the result straight through, and the UI's pass/fail styling is driven
entirely by this field, so a clean-but-Photon-less package now correctly
renders as passing rather than failing.

**Still open:** The `electron/ipc.js` `pfx:download` finding and the
`conform_engine.py` `suggestedSourceOut` finding both remain open,
unfixed, for the same WIP-overlap reason documented in prior iterations —
neither is touched by this change.

Commits: `bc4ec43`.

## Iteration 105

**Why this file:** A background scout agent flagged
`companion/src/postflowx_companion/media/backends/braw_backend.py` as a
candidate for a torn-write race in its ffmpeg fallback frame-save path.
`git diff --stat` and `git log --oneline -5 -- <file>` confirmed no
pre-existing uncommitted WIP touching this file (last two commits:
`dd8c190` and `b173ee8`, both unrelated), so it was safe to fix.

**The bug (primary, scout-reported):** `_save_frame_via_ffmpeg()` had
ffmpeg write its JPEG/PNG output directly to `out_path` — the exact same
path `get_frame()` checks with
`out_path.is_file() and out_path.stat().st_size > 0` before
unconditionally opening and base64-encoding it. Under concurrent
`get_frame()` calls (main playback thread plus the `PrefetchScheduler`
background thread), a reader could open `out_path` while ffmpeg was
still writing it, reading a truncated/torn file. The sibling
Pillow-based `_save_frame()` already avoided this by writing to a
temp file and `os.replace()`-ing it into place atomically —
`_save_frame_via_ffmpeg()` was the only frame-save path that didn't.

**Independent verification:** Read the full body of both
`_save_frame()` and `_save_frame_via_ffmpeg()`, and the `get_frame()`
read path, confirming the described asymmetry directly in source
rather than trusting the scout's summary.

**Two more bugs found while testing the fix:** Building a standalone
harness to exercise `_save_frame_via_ffmpeg()` directly surfaced two
further, independent bugs in the same function's dependency chain —
both were fixed in this iteration since they sat inside the exact
function already being touched and directly blocked verifying the
primary fix:
- `_save_frame_via_ffmpeg()` imported
  `from .standard_media_backend import _find_ffmpeg_cached` — but
  `standard_media_backend.py` never defines that name (confirmed via a
  direct Python import check). This raised `ImportError` on every call,
  meaning the entire Pillow-unavailable fallback path was completely
  broken before it could ever reach the race window above.
- The module-level `_find_ffmpeg_cached()` (defined later in the same
  file) used `from ..proxy_service import _find_ffmpeg as ff`. From
  `postflowx_companion/media/backends/braw_backend.py`, `..` only
  ascends to `postflowx_companion/media/`, not to
  `postflowx_companion/` where `proxy_service.py` actually lives —
  raising `ModuleNotFoundError`. Confirmed the real location with
  `find companion/src -iname "*proxy_service*"` and cross-referenced
  the correct three-dot usage already present in `api.py`/
  `http_server.py`.

**The fix:** `_save_frame_via_ffmpeg()` now writes ffmpeg's output to a
`tempfile.mkstemp()`-created temp file in the same directory as
`out_path`, then `os.replace()`s it into place only after ffmpeg exits
successfully — mirroring `_save_frame()`'s existing atomic-write
pattern exactly. The stray `standard_media_backend` import was removed
(falling through to the already-in-scope module-level
`_find_ffmpeg_cached()`), and its `..proxy_service` was corrected to
`...proxy_service`.

**Test approach:** A standalone harness
(`be._save_frame_via_ffmpeg(...)` called directly against a real,
unmodified `BrawBackend` instance) with a watcher thread polling the
exact final `out_path` at ~1ms intervals, re-checking its size after a
3ms settle window, to catch any torn/partial appearance of the file at
its final path.

**Verification:** Because the two self-discovered bugs raised an
exception *before* the function ever reached the write, the pre-fix
code never got far enough to reproduce the race empirically via
black-box polling — this is reported honestly rather than claiming a
reproduction that didn't happen. The structural guarantee (temp-file
write + atomic rename vs. the old direct-write-to-final-path) stands
on the code itself. Post-fix, the harness confirms: the function
completes without exception, `out_path` ends up as a single stable
206-byte JPEG, the watcher observed no size change or zero-size
appearance across repeated polls, and no leftover `.raw`/temp files
remain in the cache directory afterward. Full regression suite re-run
and matched baseline exactly: 313/7/2(pre-existing) Python, 72/1/0
Node, 22/0 JS.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, and the Metal HTJ2K
WIP block all remain open, unfixed, for the same WIP-overlap reason
documented in prior iterations — none is touched by this change.

Commits: `1abd62a`.

## Iteration 106

**Why this file:** A background scout agent flagged
`companion/src/postflowx_companion/media/backends/arri_backend.py` as a
candidate for the same torn-write defect class already fixed in
`braw_backend.py` (Iteration 105) and `r3d_backend.py` (Iteration 103),
existing here independently. `git diff --stat` and
`git log --oneline -5 -- <file>` confirmed only the repo-wide mode-bit
drift (0 content diff) — no uncommitted WIP overlapping this function,
safe to fix.

**The bug:** `ArriBackend._decode_frame_tool()` (the `art-cmd` /
ARRI Reference Tool CMD decode path) had its final `ffmpeg` encode
write directly to `out_path` — the same path every caller's cache-hit
check (`out_path.is_file() and out_path.stat().st_size > 0`) and the
final base64-read both use. `ffmpeg -y ... str(out_path)` truncates and
then writes progressively, so a concurrent reader — e.g. the
`PrefetchScheduler`'s background worker threads decoding nearby frames
while the main playback thread's `ThreadingHTTPServer` request handles
the same frame — can observe `out_path` as existing and non-empty
mid-write and read a torn JPEG/PNG straight into its response with no
error. `ArriBackend`/`ArriToolBridgeBackend` are real, registered
backends (selected automatically for `.ari`/`.arx`/ARRIRAW-wrapped
`.mxf` when `art-cmd` is installed but the full SDK isn't) — not dead
code.

**Independent verification:** Read the full body of
`_decode_frame_tool()` directly, confirming the same-path write/read
overlap in source, and confirmed via `git diff`/`git log` (above) that
the file was safe to touch.

**The fix:** The final `ffmpeg` invocation now writes to a
`tempfile.mkstemp(suffix=f".{fmt}", dir=str(self._cache))` path instead
of `out_path` directly, checks success/size on that temp path, then
`os.replace()`s it into `out_path` — an atomic swap identical in shape
to the `braw_backend.py`/`r3d_backend.py` fixes. On failure the leftover
temp file is unlinked before the exception propagates.

**Test approach:** A standalone harness
(`/tmp/verify_arri_atomic.py`) calling `_decode_frame_tool()` directly
on a real, unmodified `ArriBackend` instance, with `subprocess.run` and
`_is_art_cmd()` faked to simulate `art-cmd` writing a stub EXR and
`ffmpeg` writing the final frame in two chunks with a deliberate delay
between them (50 bytes, sleep 20ms, then 156 more bytes) — a real
watcher thread polls the exact final `out_path` (computed the same way
the function does, via the real `aces2_luts` registry, not guessed) at
~1ms intervals with a 3ms settle window.

**Verification:** Post-fix: the harness confirms `_decode_frame_tool()`
returns a `previewImagePath` matching the expected `out_path`, the file
is a stable 206-byte JPEG, the watcher observed no size change across
any poll, and no leftover temp files remain in the cache directory
afterward. Pre-fix (via `git stash push -- <file>` / `pop` around the
same harness): the code was confirmed writing directly to `out_path`
just like the post-fix temp file receives its writes, but the
polling-based watcher did not catch a torn read at this test's write
speed/interval — this is reported honestly rather than claiming an
empirical reproduction that didn't happen, consistent with the same
caveat noted for Iteration 105. The structural guarantee (temp-file
write + atomic rename vs. direct-write-to-final-path) stands on the
code itself regardless. Full regression suite re-run and matched
baseline exactly: 313/7/2(pre-existing) Python, 72/1/0 Node, 22/0 JS.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, and the Metal HTJ2K
WIP block all remain open, unfixed, for the same WIP-overlap reason
documented in prior iterations — none is touched by this change.

Commits: `7e55bf5`.

## Iteration 107

**Why this file:** `companion/src/postflowx_companion/native_host.py` is
the single-threaded stdin/stdout bridge between the Chrome extension
and the Python companion. Every native-messaging call passes through
one of two paths: dispatched to a background thread (if the action is
in `_ASYNC_ACTIONS`) or run synchronously inline on the same thread
that reads stdin. A different bug class than the last three iterations
(torn cache writes) — this one is main-loop starvation from a missing
dispatch-table entry.

**The bug:** `_ASYNC_ACTIONS` lists sibling long-running Resolve
actions — `vfxPreviewResolveStill`, `vfx.preview.resolveStill`,
`resolve.extractStillFrame`, etc., under a comment reading "OCF Resolve
still preview — imports OCF into Resolve and renders a frame (can take
30+ s)" — but was missing `"ocfDecodeFrame"`. That action is routed
(`api.py` → `self._ocf_engine_decode_frame`) through
`ocf_engine/ocf_router.py`'s `select_ocf_engine()`, which falls through
to `ENGINE_RESOLVE` for BRAW/RED/ARRI/Canon/Sony-raw clips whenever a
vendor SDK isn't linked — and `ocf_engine/ocf_decode.py`'s
`_decode_sdk()` (lines 126-129) is a hard-coded stub that always
returns a "not yet linked" failure, so in practice this is the common
path, not a rare fallback. Because `ocfDecodeFrame` was absent from
`_ASYNC_ACTIONS`, this call ran synchronously inline on the same thread
that reads stdin, freezing the entire native-messaging bridge — no
pings, health checks, or other extension calls could be serviced — for
however long the Resolve import/render took.

**Independent verification:** Confirmed `git diff --stat` and
`git log --oneline -5` on `native_host.py` showed no content diff
(mode-bit only) and no WIP overlap. Grepped `_ASYNC_ACTIONS` and
confirmed `"ocfDecodeFrame"` was absent from the frozenset while its
Resolve-preview siblings were present. Grepped `api.py` and confirmed
line 381 routes `"ocfDecodeFrame"` to `self._ocf_engine_decode_frame`.
Read `ocf_engine/ocf_decode.py` and confirmed the `ENGINE_RESOLVE`
branch (line 83) unconditionally calls the stubbed `_decode_sdk()`
(line 86), which always fails (lines 126-129), so `select_ocf_engine()`
in practice routes to Resolve. Confirmed reachability from real UI:
`src/scripts/features/ocf_engine/ocfViewer.js` lines 134 and 315 call
this path, including an explicit `engine: 'ResolveEngine'` invocation.

**The fix:** Added `"ocfDecodeFrame"` to `_ASYNC_ACTIONS`, alongside its
Resolve-preview siblings and under the existing "can take 30+ s"
comment, so it is now dispatched to a background thread like the rest
of that family — keeping the main stdin loop free to flush async
responses and service pings while the Resolve import/render runs.

**Test approach:** Built a standalone before/after harness
(`/tmp/verify_native_host_async.py`) that imports `native_host`
directly, monkeypatches `CompanionApi.handle` so `"ocfDecodeFrame"`
sleeps 0.3s and `"ping"` returns instantly, and runs `run_native_host()`
against a real OS pipe (so `select()` on stdin behaves like the real
process) with a custom stdout capturer that timestamps each framed
response as it's written. Sends an `ocfDecodeFrame` message followed
immediately by a `ping`, once with `_ASYNC_ACTIONS` in its real
(post-fix) state and once with `"ocfDecodeFrame"` removed from the set
to reproduce the pre-fix behavior.

**Verification:** Post-fix, the `ping` response arrived at 0.003s —
before the slow response's 0.329s — proving the main loop kept
servicing stdin while the Resolve-style call ran in the background.
Pre-fix (with `ocfDecodeFrame` removed from `_ASYNC_ACTIONS`), the
`ping` response was withheld until 0.304s, arriving simultaneously with
the slow response, confirming the starvation bug is real and that the
fix resolves it. Full regression suite re-run and matched baseline
exactly: 313/7/2(pre-existing) Python, 72/1/0 Node, 22/0 JS.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, and the Metal HTJ2K
WIP block all remain open, unfixed, for the same WIP-overlap reason
documented in prior iterations — none is touched by this change. The
`ocf_decode.py` `_decode_sdk()` stub itself (why Resolve is the de
facto engine for raw formats even when a vendor SDK path is intended)
is also unaddressed — fixing it is a larger SDK-integration task
outside this iteration's scope.

Commits: `57ac6af`.

## Iteration 108

**Why this file:** `companion/src/postflowx_companion/ocf_engine/ocf_proxy.py`
backs the OCF viewer's "Generate Proxy" button. A different bug class
than the last two iterations (torn writes, main-loop starvation): this
one is an unbounded in-memory leak in a long-lived server process.

**The bug:** `generate_proxy_async()` (line 140) inserts one entry per
call into the module-level `_jobs: dict[str, dict] = {}` (line 156),
keyed by a fresh UUID. `proxy_job_status()` (line 159) only ever reads
`_jobs`; nothing in the module pops, expires, or caps it once a job
reaches `"state": "done"`. Every proxy generated during a companion
server's uptime — which spans many sessions/projects in normal use —
leaves one entry (including its full result payload: proxy path,
codec, frame count, errors) permanently resident. By contrast, the
sibling job registry in `api.py` (`self._ocf_jobs`, used for OCF
exports) already has an eviction cap (`_OCF_JOBS_MAX = 64`, lines
2767/2781-2785) — this proxy-job registry was simply never given the
same treatment.

**Independent verification:** Read the full producer/consumer path:
`_jobs[job_id] = {"state": "running", ...}` (line 144),
`_jobs[job_id]["pct"] = pct` (line 148) and
`_jobs[job_id] = {"state": "done", ...}` (line 150) in
`generate_proxy_async`, and the sole read in `proxy_job_status` (line
160) — no eviction anywhere. Confirmed production reachability:
`src/scripts/features/ocf_engine/ocfViewer.js` `_startProxy()` (line
333) → `ocfGenerateProxy` IPC → `api.py:6811` →
`ocf_engine.ocf_proxy.generate_proxy_async()`; the viewer's
`_pollProxy()` (line 352) polls `ocfProxyJobStatus` → `api.py:6823`
`_ocf_proxy_job_status` → `proxy_job_status()`, stopping once it sees
`state === 'done'` (line 355) — it never signals the server to forget
the job. `git diff --stat` and `git log --oneline -5` on
`ocf_proxy.py` showed no uncommitted changes and no WIP overlap before
this fix.

**The fix:** Added `_JOBS_MAX = 64` and an eviction step inside
`proxy_job_status()`, mirroring the existing `_ocf_jobs` pattern in
`api.py`: once `_jobs` exceeds the cap, the oldest `"done"` entries
(excluding the one just queried) are dropped down to half the cap.

**Test approach:** Built a standalone before/after harness
(`/tmp/verify_ocf_proxy_jobs_bounded.py`) that imports `ocf_proxy`
directly, inserts 500 synthetic `"done"` jobs, and calls
`proxy_job_status()` on each exactly once (mirroring the real JS
poller, which polls until `done` then stops) — then asserts the
registry size stays at or below `_JOBS_MAX` and that the most recently
polled job is still resolvable (proving eviction doesn't blow away a
job the caller just asked about).

**Verification:** Pre-fix (via `git stash push -- ocf_proxy.py`), all
500 synthetic jobs remained in `_jobs` after polling — confirming the
unbounded leak is real. Post-fix, re-run after `git stash pop` restored
the fix correctly (`git diff` confirmed): `_jobs` settled at 52 entries
(≤ 64 cap) after the same 500 jobs, and the most recent job (`job0499`)
was still queryable. Full regression suite re-run and matched baseline
exactly: 313/7/2(pre-existing) Python, 72/1/0 Node, 22/0 JS.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, the Metal HTJ2K WIP
block, and the `ocf_decode.py` `_decode_sdk()` stub all remain open,
unfixed, for the reasons documented in prior iterations — none is
touched by this change.

Commits: `3805fd9`.

## Iteration 109

**Why this file:** `proxy_service.py`'s multi-reel parallel-decode path
(`_transcode_worker_inner` → `_parallel_decode_and_concat`, lines
~4676–4760) is the fast path used for any IMF/OCF package with 2+
reels — the common case for real deliveries. `git diff --stat` and
`git log --oneline -5` on the file showed no uncommitted changes before
this fix, so there was no WIP to avoid.

**The bug:** `_parallel_decode_and_concat` spins up one ffmpeg process
per reel inside a `ThreadPoolExecutor`, via `_decode_seg()` calling
`subprocess.run(cmd, capture_output=True, timeout=...)`. None of these
per-reel processes were ever registered in the session state — only
the single sequential-path process (`_run_ffmpeg`) and the final mux
process are stored via `update_session(session_id, proc=...)`.
`stop_session()` only ever killed that single `state["proc"]` key. Since
`subprocess.run()` blocks its worker thread until ffmpeg exits (up to a
`max(600, exp_dur*4)`-second timeout) or is killed, cancelling a
multi-reel proxy build mid-decode removed the session bookkeeping but
left every in-flight reel-decoder ffmpeg process running to completion,
burning CPU and holding temp files in `tmp_dir` until each one finished
or timed out on its own. A user who cancels a multi-reel build and
immediately starts another leaks N orphaned ffmpeg processes contending
with the new job. This was scouted independently, then verified by
reading the actual code (confirmed only `proc=`, never `procs=`, is set
anywhere in the parallel path, and `stop_session` only reads
`state.get("proc")`).

**The fix:** `_decode_seg()` now uses `subprocess.Popen` instead of
`subprocess.run`, appending each live `Popen` to a shared
`_active_procs` list (guarded by a lock) that is registered once via
`update_session(session_id, procs=_active_procs, ...)` — since the
dict value is the same list object, later appends are visible to
whatever reads session state afterward, including `stop_session`.
`stop_session()` now also iterates `state.get("procs")` and kills every
entry there, not just the single `state["proc"]`. Exceptions (including
the per-reel timeout) still kill that reel's own process before
returning, matching the original behavior for the non-cancellation
case.

**Test approach:** Because `_decode_seg`/`_active_procs` are closures
nested three levels inside `_transcode_worker_inner`, they can't be
imported in isolation without driving a full real IMF-package build.
Instead, the harness (`/tmp/verify_stop_session_kills_procs.py`) tests
the exact trust boundary the bug and fix live on: it creates a real
session via `service_state.create_session` with `state["procs"]` set to
a list of real long-running `sleep 30` subprocesses (reproducing
exactly what `_active_procs` looks like mid-decode), then calls the
real, unmodified `stop_session()` and asserts every process was
actually killed.

**Verification:** Pre-fix (via `git stash push -- proxy_service.py`),
`stop_session()` ignored `state["procs"]` entirely — all 4 simulated
reel-decoder processes were still alive after the call, and
`Popen.wait(timeout=5)` on them raised `TimeoutExpired`, confirming the
orphaning. Post-fix, re-run after `git stash pop` restored the fix
correctly (`git diff` confirmed only content changes, no mode-bit-only
noise): all 4 processes were killed and reaped immediately. Full
regression suite re-run and matched baseline exactly: 313/7/2
(pre-existing, `conform_engine.py` WIP under Python 3.9) Python, 72/1/0
Node, 22/0 JS.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, the Metal HTJ2K WIP
block, and the `ocf_decode.py` `_decode_sdk()` stub all remain open,
unfixed, for the reasons documented in prior iterations — none is
touched by this change.

Commits: `4efae26`.

## Iteration 110

**Why this file:** `resolve_engine.py`'s `_run_proxy_export` (the
DaVinci Resolve proxy-export job path, lines ~627-854) is the primary
production path for any proxy-export job run against a live Resolve
instance. `git diff --stat -- companion/src/postflowx_companion/engines/resolve_engine.py`
and `git log --oneline -5` on the file showed no uncommitted changes
before this fix, so there was no WIP to avoid.

**The bug:** After `StartRendering()` completes, the "verify output"
step (originally lines 830-833) globbed the *entire* `outputDir` for
any `.mov`/`.mp4`/`.mxf` file and reported all of them as this job's
`outputs`, with no filtering by render start time or expected
filename. Since `outputDir` can be reused across jobs (e.g. re-running
a failed job into the same folder, or a shared per-project output
directory), any stale file left over from a prior render would pass
the same glob check and get reported as this render's own output —
silently handing the caller a wrong/stale proxy path, and also masking
a genuine render failure that produced zero new files if a pre-existing
file alone satisfied the non-empty check.

**The fix:** Capture `render_start_ts = time.time()` immediately before
`StartRendering()` is called, then filter the output-directory glob to
only files with `st_mtime >= render_start_ts - 2.0` (a small negative
epsilon to tolerate clock skew between the filesystem and the Python
process). Minimal, 9-line change; no behavior change for the common
case of an empty/dedicated `outputDir`.

**Test approach:** `_run_proxy_export` drives the real DaVinci Resolve
scripting API (`resolve_app.GetProjectManager()` → `pm.CreateProject()`
→ `project.GetMediaPool()` → …), which isn't available outside a
running Resolve instance. The harness
(`/tmp/verify_proxy_export_stale_glob.py`) mocks only the Resolve API
surface (`resolve_app`/`pm`/`project`/`media_pool`) with `MagicMock`,
configured so `GetRenderJobStatus()` reports `"Complete"` immediately
and, on that same call, creates the real render's output file on disk
— mirroring the real timing where Resolve writes the file at/after job
completion. A stale `.mov` file with an mtime one hour in the past is
pre-seeded in the shared `outputDir` before calling the real,
unmodified `_run_proxy_export()`.

**Verification:** Pre-fix (via `git stash push -- resolve_engine.py`),
the harness's `outputs` result included both the stale leftover file
and the real render output — reproducing the bug exactly. Post-fix,
re-run after `git stash pop` restored the fix correctly (`git diff`
confirmed only content changes, no mode-bit-only noise): `outputs`
contained only the real render's own file, and the stale file was
excluded. Full regression suite re-run and matched baseline exactly:
313/7/2 (pre-existing, `conform_engine.py` WIP under Python 3.9) Python
via direct `pytest -q` in the companion venv (315/7/0 as reported by
`npm test`'s newer Python interpreter — same known environmental
difference documented in prior iterations), 72/1/0 Node, 22/0 JS.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, the Metal HTJ2K WIP
block, and the `ocf_decode.py` `_decode_sdk()` stub all remain open,
unfixed, for the reasons documented in prior iterations — none is
touched by this change.

Commits: `6e44543`.

## Iteration 111

**Why this file:** `color_lut.py`'s `get_idt_lut_path()`/`_write_cube()`
generate and cache per-camera-family `.cube` 3D LUT files used by the
OCF EXR export path. `api.py`'s `_ocf_exr_export_start()` spawns one
`threading.Thread(target=self._ocf_run_export, ...)` per OCF export
job (line 2344), and `_ocf_run_export()` calls
`_get_idt_lut_path(_idt_name, _lut_cache_dir)` (line 2532) — so two
concurrent OCF export jobs for clips of the same camera family
genuinely race on the same cache directory and the same `.cube` path.
Confirmed via `git diff --stat`/`git log --oneline -5 --
color_lut.py`: no pre-existing WIP on this file, only unrelated prior
color-math fix commits.

**The bug:** `get_idt_lut_path()` did an unsynchronized
check-then-write (`if not os.path.isfile(path): _write_cube(path, ...)`)
with no lock, and `_write_cube()` wrote the ~36,000-line `.cube` file
directly to its final path via a single `open(path, "w")` +
`fh.write()` — not atomically. Two concurrent threads processing clips
of the same camera family could both pass the `isfile()` check and
both write to the same path concurrently, and — independent of that —
any reader (a third OCF job reusing the cached path, or ffmpeg's
`lut3d` filter) could open the file while a writer's buffered `write()`
calls were still flushing to disk in multiple OS-level writes, seeing
a truncated/partial file rather than a complete one.

**The fix:** Added a module-level `threading.Lock()` (`_CACHE_LOCK`)
guarding the check-then-write in `get_idt_lut_path()` (re-checking the
in-memory `_CACHE` dict first inside the lock, to avoid holding the
lock for cache hits from a second thread). Made `_write_cube()`'s file
write atomic: write to a per-thread/per-process temp path
(`{path}.tmp.{pid}.{thread_id}`), then `os.replace(tmp_path, path)` —
the same write-to-tmp-then-rename pattern already used elsewhere in
the codebase (`frame_cache.py`, `proxy_registry.py`).

**Test approach:** Two standalone harnesses drove the real, unmodified
`color_lut` module functions directly (no mocking — this file is pure
Python with no external dependencies):
- `/tmp/verify_lut_race.py`: 12 real `threading.Thread`s calling
  `get_idt_lut_path("ARRI LogC3", lut_dir)` concurrently across 5
  trials, validating exact line count and well-formed rows. This
  harness passed both before and after the fix — expected, since all
  racing threads write byte-identical LUT content for the same camera
  family key, so a torn write rarely produces a *detectably* corrupt
  file at this size/timing.
- `/tmp/verify_lut_torn_read.py`: a more targeted harness isolating the
  actual atomicity property the fix provides. One thread calls the
  real `_write_cube()` directly; a second thread concurrently polls
  the target path in a tight loop (with `sys.setswitchinterval(0.00005)`
  to widen the GIL-scheduling window enough for the race to surface),
  reading and checking for the expected line count / trailing newline
  on every read that catches the file mid-write, across 20 trials.

**Verification:** Pre-fix (via `git stash push -- color_lut.py`), the
torn-read harness reproduced the bug directly: 14 of 54 reads that
caught the file while being written saw a partial/truncated `.cube`
file. Post-fix (after `git stash pop`, confirmed via `git diff` that
only genuine content changes were restored — no mode-bit-only noise on
this file), the same harness saw 0 torn reads across 40 reads in 20
trials, and the original 12-thread concurrency harness still passed
(35942/35942 lines, well-formed, no leftover `.tmp.` files). Full
regression suite re-run and matched baseline exactly: 313/7/2
(pre-existing, `conform_engine.py` WIP under Python 3.9) Python via
direct `pytest -q` in the companion venv (315/7/0 as reported by
`npm test`'s newer Python interpreter), all Node (`node --test`) and
JS suites passing with 0 failures.

**Still open:** The `electron/ipc.js` `pfx:download` finding, the
`conform_engine.py` `suggestedSourceOut` finding, the Metal HTJ2K WIP
block, and the `ocf_decode.py` `_decode_sdk()` stub all remain open,
unfixed, for the reasons documented in prior iterations — none is
touched by this change.

Commits: `d938f46`.

## Iteration 112 — proxyJobPoller.js cancellation race commits stale SWI state

**Why this file:** `src/scripts/core/proxyJobPoller.js` runs a
`setInterval`-driven `async` tick per active proxy render job, polling
`PFX_RENDER_WORKER.getJobStatus()` and writing terminal-state results
(done/failed/error/cancelled) to SWI via `PFX_SWI.update()`. The public
`cancelWatch(jobId)` API is synchronous and can be called at any time —
e.g. when a user closes a shot or triggers a retry render for the same
shot — while a tick for that same `jobId` is already suspended mid-flight
on one of several `await` points.

**The bug:** Each tick captured `_watchers[jobId]` at the top of the
callback but never re-checked it after any subsequent `await`. A
`cancelWatch()` call landing during an in-flight tick's `await
getJobStatus()` (or any later `await`) had no effect on that tick — it
ran to completion regardless, and if the poll happened to resolve to a
terminal status (`done`/`failed`/`error`/`cancelled`), the tick would
still call `_stopWatcher(jobId)` and unconditionally write SWI state and
dispatch `pfx_proxy_committed` for a job the caller had already
cancelled. In the retry-render case this meant a superseded job's stale
result could clobber SWI state written by (or intended for) the new
retry.

**The fix:** Added a per-tick `isLive = () => _watchers[jobId] === w`
liveness check (capturing the watcher entry `w` at tick start) and
inserted a check immediately before every side-effecting action that
follows an `await` — the progress-update write, and each terminal-state
branch's `_stopWatcher` + SWI write. The check had to be placed
carefully: any async pre-work (e.g. `_getSwiProxy()` calls building
`proxyPatch`) happens first, then `isLive()` is checked, and only if
still live does the code call its own `_stopWatcher(jobId)` — checking
liveness *after* `_stopWatcher` would always read as "not live" (since
`_stopWatcher` itself deletes the entry), incorrectly suppressing the
legitimate self-initiated-stop case. Also added an `_ticking` re-entrancy
guard so overlapping ticks (a slow poll response outliving the next
`POLL_INTERVAL_MS` tick) can't race each other independently of
cancellation.

**Test approach:** `tests-js/proxyJobPollerCancelRace.test.mjs`, built on
the existing `vm.createContext`/`vm.runInContext` sandbox pattern
(established by `crossTabQueueLeaseRace.test.mjs`): the real, unmodified
`proxyJobPoller.js` source is loaded into a sandboxed context with a
manually-controlled `setInterval` (captured, not real-timer-driven) and a
`deferred()` promise gating `getJobStatus()`'s resolution. The test fires
one tick, calls the real `cancelWatch()` while the tick is suspended
mid-`await`, then resolves the gate to `done` and asserts zero SWI writes
and zero dispatched events. A second test confirms the non-cancelled
happy path still commits exactly once.

**Verification:** Pre-fix (via `git stash push -- src/scripts/core/proxyJobPoller.js`,
confirmed reverted via `grep -c isLive` returning 0), the cancellation
test failed exactly as predicted: `swiUpdateCalls.length` was 1 instead
of 0, with the actual patch showing the stale `proxyStatus: 'failed'`
write going through for the cancelled job. Post-fix (after `git stash
pop`, confirmed restored via `grep`/`git diff --stat`), both tests pass
(2/2). Full regression suite re-run and matched baseline exactly:
`test:js` — every file in `tests-js/*.test.mjs` reports 0 failed (this
new test file included); `test:node` — 72 passed, 0 failed, 1 skipped;
`test:py` — 315 passed, 7 skipped, 0 failed (via `npm run test:py`'s
Python interpreter).

**Still open:** `_commitProxy()` writes to `shotWorkId`'s SWI record
unconditionally, without checking whether a newer `jobId` watcher has
since been registered for the same `shotWorkId` (e.g. via a retry flow
started after the original job already reached a terminal state but
before `_commitProxy`'s own `await`s resolved). The `isLive()` guard
added this iteration correctly prevents a *cancelled* job's tick from
committing, but does not protect against two *concurrently live*
watchers for the same `shotWorkId` racing each other — a distinct,
deeper concern left undocumented-but-unfixed pending a clearer picture
of whether that scenario is actually reachable from the UI (retry flows
may already call `cancelWatch()` on the old job before starting a new
one, which would make this unreachable in practice, but that call site
wasn't audited this iteration).

Commits: `f937a99`.

## Iteration 114 — smartRun.js preflight-modal backdrop click never resolves `run()`, hanging Smart Run forever

**Why this file:** `src/scripts/core/smartRun.js` implements the "⚡ Smart
Run" pipeline: `run()` builds a preflight summary and then `await`s a
`Promise` that only settles when the user either clicks "Run" or
cancels the confirmation modal shown by `_showPreflightModal(onRun,
onCancel)`. The `finally` block that follows that `await` is
responsible for resetting the `_running` guard and re-enabling/relabeling
the Smart Run button, so anything that leaves the modal open without
ever calling `onRun` or `onCancel` freezes the whole feature.

**The bug:** The preflight modal supports closing via backdrop click (as
well as its explicit Cancel button), but the backdrop-click handler was
wired up once in `_init()` via `modal.addEventListener('click', ...)`
and only ever hid the modal (`modal.style.display = 'none'`) — it never
invoked either the `onRun` or `onCancel` callback captured by the
in-flight `_showPreflightModal` call. A user who dismissed the modal by
clicking outside it (rather than pressing Cancel) therefore left `run()`
awaiting a Promise that could never resolve: `_running` was never reset
and the Smart Run button stayed disabled with its in-progress label
permanently, requiring a full page reload to recover.

**The fix:** Moved the backdrop-click binding out of `_init()` and into
`_showPreflightModal` itself, rebinding it per call (mirroring how
`cancelBtn.onclick` is already rebound per call) so it always closes
over the *current* call's `onCancel`:
```js
const _close = () => { modal.style.display = 'none'; };
modal.onclick = (e) => { if (e.target === modal) { _close(); onCancel?.(); } };
if (cancelBtn) cancelBtn.onclick = () => { _close(); onCancel?.(); };
```
The old `_init()`-level `addEventListener` handler was removed entirely
so there is no longer a stale, non-resolving listener left registered
from module load.

**Test approach:** `tests-js/smartRunPreflightBackdrop.test.mjs`, a new
hybrid harness combining two already-established patterns: `linkedom`'s
`parseHTML` (used elsewhere for `smart_engine_settings.js`'s ES-module
tests) builds a real `window`/`document` pair with genuine
`EventTarget`/`onclick` semantics, which is then fed into a
`vm.createContext`/`vm.runInContext` sandbox (the pattern established by
`shotWorkItemsUpdateRace.test.mjs`) to execute `smartRun.js`'s real,
unmodified IIFE source — necessary because `smartRun.js` is a plain
script, not an ES module, so it can't be `import()`ed directly like
`smart_engine_settings.js`. The test calls `PFX_SMART_RUN.run()`, flushes
microtasks until the modal is showing, dispatches a real `click` event
directly on the modal element (`e.target === modal`, matching the
backdrop-vs-content check), then races `run()`'s Promise against a
500ms timeout so a regression fails the test instead of hanging the
whole suite. It also asserts the modal actually closes and that the
Smart Run button's `disabled` state and label are restored.

**Verification:** Pre-fix (temporarily reverted `_showPreflightModal`'s
`modal.onclick` binding and restored the old `_init()`-level
`addEventListener` handler, confirmed via `git diff`), the test failed
exactly as predicted: `AssertionError: run() never resolved after a
backdrop click — the pipeline is hung`, at ~508ms (the timeout race
losing). Post-fix (restored the real fix from a backup copy, confirmed
via diff), the test passes in ~5.7ms. Full regression suite re-run and
matched baseline exactly: `test:js` — every file in `tests-js/*.test.mjs`
reports 0 failed (this new test file included; `selfContained.test.mjs`
flags the new file as untracked until committed, matching the
established pattern for every prior iteration's new test file);
`test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 315 passed, 7
skipped, 0 failed.

**Still open:** No other callers of `_showPreflightModal` were found,
but the same per-call-rebind pattern (rather than a one-time `_init()`
listener) should be the default template for any future modal in this
file that captures call-specific callbacks — a one-time listener bound
in `_init()` is the recurring shape of this bug class and is easy to
reintroduce by accident if a new modal is added without checking this
precedent.

Commits: `654a53c`.

## Iteration 113 — shotWorkItems.js `update()` lost-update race across two IDB transactions

**Why this file:** `src/scripts/core/shotWorkItems.js` implements
`PFX_SWI`, the IndexedDB-backed data model every VFX marker's
ShotWorkItem lives in. `update(shotWorkId, patch)` is the single
read-modify-write entry point every other module uses to mutate a
ShotWorkItem — `proxyJobPoller.js` calls it on every 2-second poll tick
(progress updates, terminal-state commits), `colorRecipe.js` calls it
when a color recipe resolves, `proxyFingerprint.js` calls it to mark
proxies rendered/stale, and `smartRun.js`'s cut-diff reaction calls it
to patch a marker's TC range after an edit. These call sites are
independently triggered by unrelated async flows (a network poll vs. a
user's timeline edit vs. a color-recipe resolution) with no
coordination between them, and can legitimately target the same
`shotWorkId` around the same time — e.g. a proxy render's progress tick
and a mid-render cut-diff TC change on the same shot.

**The bug:** `update()` was implemented as:

```js
async function update(shotWorkId, patch) {
  const existing = await getById(shotWorkId);
  if (!existing) return null;
  const updated = { ...existing, ...patch, shotWorkId, updatedAt: _now() };
  return save(updated);
}
```

`getById()` runs in its own `readonly` IDB transaction; `save()` runs in
its own separate `readwrite` transaction. Because these are two
independent transactions with an `await` between them and no per-key
locking, two concurrent `update()` calls for the same `shotWorkId` can
both have their `getById()` resolve against the same pre-write record
before either call's `save()` has landed. Whichever `save()` completes
second wins, silently discarding the first call's patch — a classic
lost-update race. The same shape (separate read-transaction +
write-transaction with no lock) was already identified and fixed once
before in this codebase, in `crossTabQueueLease.js`'s
`acquireLease()`/`releaseLease()`, which now read-then-write inside a
single transaction specifically to close this class of race — but the
fix was never applied to `shotWorkItems.js`'s `update()`, which has the
identical shape. A secondary consequence of the two-transaction split:
calling `update()` on a nonexistent `shotWorkId` could still result in
`save()` writing a phantom record if a concurrent `create` landed
between the `getById` miss and... in practice the more directly
observable secondary bug is that the naive two-transaction shape gives
no atomicity guarantee at all for the existence check either.

**The fix:** Collapsed `update()`'s get + merge + put into a single IDB
`readwrite` transaction (`db.transaction(DB_STORE, 'readwrite')`, one
`store.get()` whose `onsuccess` handler calls `store.put()` on the same
transaction), matching the exact pattern already established in
`crossTabQueueLease.js`. IndexedDB serializes readwrite transactions
that touch the same object store, so a second `update()` call's `get()`
is guaranteed to only run after the first call's `put()` has fully
committed (or vice versa) — never interleaved. `_broadcast()` now fires
only when a record actually existed and was written.

**Test approach:** New `tests-js/shotWorkItemsUpdateRace.test.mjs`,
using the same `vm.createContext`/`vm.runInContext` sandbox pattern as
`crossTabQueueLeaseRace.test.mjs`, with a transaction-order-gated fake
IndexedDB (`createGatedFakeIndexedDB`) adapted from that same test file
(generalized for `shotWorkItems.js`'s keyPath-based store). The store is
paused so both of two concurrent `update()` calls' work queues before
either drains, then the test drives the queued transactions to
completion one at a time via `runPendingAt(i)` and asserts both
patches' fields survive in the final record. A second test asserts
`update()` on an unknown `shotWorkId` returns `null` and writes nothing.

**Verification:** Pre-fix (temporarily restored the original
two-transaction `update()` body, confirmed via `grep -n "async function
update"`), the concurrent-update test hung/timed out — with two fully
separate `readonly`+`readwrite` transaction pairs per call, the fake
IndexedDB's gated queue never reached the state the test's fixed
two-step drive sequence expected, and the unknown-id test failed outright:
it asserted `update('does-not-exist', ...)` returns `null`, but the
two-transaction version wrote a phantom record (`{ shotWorkId:
'does-not-exist', proxyProgress: 1, ... }`) instead of correctly
returning `null`. Post-fix (restored the single-transaction version),
both tests pass (2/2), confirmed by direct `node --test` runs before
folding into the full suite. Full regression suite re-run and matched
baseline exactly: `test:js` — every file in `tests-js/*.test.mjs`
reports 0 failed (the one exception, `selfContained.test.mjs`'s
git-tracking gate flagging the new untracked test file, resolves once
the file is staged and committed, matching the pattern for every prior
iteration's new test file); `test:node` — 72 passed, 0 failed, 1
skipped; `test:py` — 315 passed, 7 skipped, 0 failed.

**Still open:** `save()` itself (used directly by `createFromMarker`'s
initial write, `importState`, and now internally unused by `update()`)
is unaffected by this fix and remains a single-transaction `put()`,
which is fine since each `createFromMarker` call generates a fresh
unique `shotWorkId` with no cross-call contention. Not audited this
iteration: whether `renameByMarkerIds()`'s per-marker loop (which
serially `await`s `update()` for each marker) could still race against
one of `update()`'s other external callers landing between two of its
own iterations — this seems unlikely to matter in practice since each
iteration targets a different `shotWorkId`, but wasn't specifically
confirmed.

Commits: `5052324`.

## Iteration 115 — smartExrExportQueue.js lost-cancellation race silently overwrites CANCELLED with a stale QC result

**Why this file:** `src/scripts/smart/smartExrExportQueue.js` implements
`ExrExportQueue`, the async job queue that drives the Smart EXR pull's
per-shot export/QC pipeline. `_runJob(state)` is the per-job worker:
it calls the native dispatch to actually export the EXR sequence,
awaits that promise, then runs QC validation and lands the job on one
of `QC_PASSED`/`QC_WARNING`/`QC_FAILED`. `cancel(jobId)` is the only
way a user can abort an in-flight export from the queue UI, and it is
synchronous — it must take effect immediately regardless of what
`_runJob` happens to be awaiting at that moment, since native EXR
dispatch calls can run for many seconds.

**The bug:** `cancel(jobId)` sets `state.cancelRequested = true` and
`state.status = JOB_STATUS.CANCELLED` synchronously, but `_runJob`
never re-checked `cancelRequested` after resuming from an `await`. If
a user cancelled a job while `await this._nativeDispatch(...)` was
still in flight, the status flip to `CANCELLED` was silently
overwritten the moment that stale promise resolved: `_runJob` would
plow ahead into `state.result = result`, `state.status =
JOB_STATUS.QC_RUNNING`, and eventually a real
`QC_PASSED`/`QC_WARNING`/`QC_FAILED` (or `FAILED`, if the stale promise
instead rejected in the `catch` block) — clobbering the cancellation
with a result the user had explicitly told the queue to discard. This
is the same bug class as the already-fixed Iteration 112
`proxyJobPoller.js` cancellation race: a stale-callback pattern where
liveness/cancellation state must be re-checked after every `await`,
not just captured once at the start.

**The fix:** Added `if (state.cancelRequested) { ...; return; }` guards
at every point `_runJob` resumes after an `await` or lands in the
`catch` block — immediately after `await this._nativeDispatch(...)`
resolves, immediately after the QC `await this._yield()`, and at the
top of the `catch` block — so a cancellation that arrived mid-flight
short-circuits before any further status/result mutation, leaving
`state.status` at `CANCELLED` and `state.result` untouched:

```js
if (state.cancelRequested) {
  this._log(state.id, 'Export finished after cancel — result discarded');
  this._notify(state.id);
  return;
}
```

(and the equivalent guard after the QC yield and in the `catch`
block).

**Test approach:** `tests-js/smartExrExportQueueCancelRace.test.mjs`,
a new test that `import`s `ExrExportQueue`/`JOB_STATUS` directly —
unlike `smartRun.js` (Iteration 114), `smartExrExportQueue.js` is
already an ES module with named exports, so no vm-sandbox or linkedom
hybrid harness is needed. The test installs a native dispatch backed
by a manually-controlled deferred promise (`gate`), starts the queue,
waits one tick to confirm the job has reached `EXPORTING` (i.e.
`_runJob` is suspended on `await this._nativeDispatch(...)`), calls
`cancel()` and confirms the status is immediately `CANCELLED`, then
resolves the stale dispatch promise and awaits the queue's `start()`
to finish. It asserts the job's final status is still `CANCELLED` (not
overwritten by whatever QC status the stale result would have
produced) and that `state.result` was never populated with the
discarded export result.

**Verification:** Pre-fix (temporarily reverted all three
`cancelRequested` guards back to the original code via `git diff`
against a backed-up fixed copy), the test failed exactly as predicted:
`AssertionError [ERR_ASSERTION]: cancelled job status must survive a
late dispatch resolution, got QC Failed` (`actual: 'QC Failed'`,
`expected: 'Cancelled'`). Post-fix (restored from the backup, confirmed
via diff), the test passes in ~2.6ms. Full regression suite re-run and
matched baseline exactly: `test:js` — every file in
`tests-js/*.test.mjs` reports 0 failed (this new test file included;
`selfContained.test.mjs` flags it as untracked until staged/committed,
matching the established pattern for every prior iteration's new test
file); `test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 315
passed, 7 skipped, 0 failed.

**Still open:** `cancelAll()` funnels through the same `cancel()` path
per job, so it inherits the same fix automatically — not separately
tested this iteration. `retry(jobId)` resets `cancelRequested = false`
before restarting a job, which is correct for a fresh attempt, but
relies on the previous `_runJob` invocation for that same state object
having already returned (via one of the new guards) before `retry()`
mutates `cancelRequested` again; no interleaving where `retry()` fires
while the old `_runJob` call is still mid-flight was found, but this
wasn't exhaustively audited.

Commits: `c6bf912`.

## Iteration 116 — ReviewPlayer._switchToNextIfNeeded() auto-advance race clobbers a concurrent manual seek

**Why this file:** `src/scripts/features/reviews/player.js` implements
`ReviewPlayer`, the VFX Reviews virtual-timeline player. It drives two
`<video>` elements (`active`/`standby`) and swaps which is which as
playback crosses clip boundaries, so the next clip can be preloaded into
`standby` while `active` is still playing. Two independent code paths can
each decide to reload the shared `standby` element and await that load:
`loadAtGlobalTime()` (any manual seek — scrubbing, prev/next-clip, J/L
shuttle landing on a new clip) and `_switchToNextIfNeeded()` (the
per-frame tick loop's auto-advance check, fired every animation frame
once the active clip is within 0.35s of its end). Both are async and can
be in flight at the same time against the same `standby` element.

**The bug:** `loadAtGlobalTime()` already guards against this shared-state
race with a generation-token pattern: it captures `const seq =
++this._loadSeq` before `await this._loadVideo(this.standby, ...)`, then
checks `if (seq !== this._loadSeq) return;` after resuming, so a stale
load that got superseded by a newer one bails out instead of acting on
outdated data. `_switchToNextIfNeeded()` reloads the exact same shared
`standby` element the exact same way but had no such guard — its
`this._switching` flag only prevented *re-entering* itself, not
interference from a concurrent `loadAtGlobalTime()` call. Sequence: the
tick loop detects the active clip is about to end and starts loading the
next clip into `standby`; before that resolves, the user manually seeks
(e.g. clicks "next clip" or scrubs) to a different clip, which reloads
the *same* `standby` element with different content and bumps
`_loadSeq`. When the auto-advance's stale `_loadVideo` promise then
resolves, `_switchToNextIfNeeded()` had no way to know it was superseded
— it swapped in the stale clip and called
`this.store.setActiveIndex(nextIndex)` with the auto-advance's target
index, momentarily (or, depending on scheduling, permanently)
overwriting the manual seek's own already-correct `setActiveIndex` call
and video assignment with stale data.

**The fix:** Added the identical `_loadSeq` generation-token guard already
proven in `loadAtGlobalTime()` to `_switchToNextIfNeeded()`'s reload
branch:

```js
if (needReload) {
  const seq = ++this._loadSeq;
  const ok = await this._loadVideo(this.standby, nextSeg.url, nextIn);
  if (seq !== this._loadSeq) return;
  if (!ok) {
    ...
```

Any concurrent call that also bumps `_loadSeq` (whether another
`_switchToNextIfNeeded()` invocation or a `loadAtGlobalTime()` manual
seek) now causes the stale auto-advance to bail out immediately after its
load resolves, before touching `store.setActiveIndex`, `_swapVideos`, or
any playback state.

**Test approach:** `tests-js/reviewPlayerSwitchLoadRace.test.mjs`, a new
linkedom-based test following the existing
`reviewPlayerSameSource.test.mjs` harness pattern (parseHTML
window/document, `document.baseURI` override, real `<video>` elements via
`document.createElement('video')`, dynamic import of `ReviewPlayer`). The
video elements are stubbed with no-op `load`/`play`/`pause` since
linkedom doesn't implement `HTMLMediaElement` behavior, and
`requestAnimationFrame`/`cancelAnimationFrame` are stubbed globally since
`pause()` calls `cancelAnimationFrame`. A minimal fake `store` tracks
every `setActiveIndex` call in an array. The test sets up 3 segments from
distinct source URLs, positions the active video 0.3s from its end (so
`_switchToNextIfNeeded()` fires the auto-advance path targeting clip1),
kicks it off without awaiting (so it suspends mid-`_loadVideo` on the
shared standby element), then calls `loadAtGlobalTime()` targeting clip2
— which reloads the same standby element and bumps `_loadSeq` again
while the switch is still pending. Dispatching `loadedmetadata` +
`loadeddata` on the shared standby element resolves both in-flight
`_loadVideo` calls at once, in listener-attachment order (stale switch
first, then the seek). The test asserts exactly one `setActiveIndex` call
landed (the seek's, targeting clip2) and that `_switching` was correctly
reset.

**Verification:** Pre-fix (temporarily removed the `seq`/`_loadSeq` guard
from `_switchToNextIfNeeded()`, restoring the exact single-line
`_loadVideo` call), the test failed exactly as predicted:
`setActiveIndexLog` recorded `[1, 2]` instead of `[2]` — the stale
auto-advance's `setActiveIndex(1)` landed before being overwritten by the
seek's own `setActiveIndex(2)`, confirming the race is real and would (in
a scenario with different scheduling, or a third overlapping call) leave
the player showing the wrong clip. Post-fix (restored from a backup,
confirmed via `git diff --stat`), all 7 assertions pass. Full regression
suite re-run and matched baseline exactly: `test:js` — every file in
`tests-js/*.test.mjs` reports 0 failed (this new test file included;
`selfContained.test.mjs` flags it as untracked until staged/committed,
matching the established pattern for every prior iteration's new test
file); `test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 315
passed, 7 skipped, 0 failed.

**Still open:** `preloadNext()` (called fire-and-forget, not awaited,
from both `loadAtGlobalTime()` and `_switchToNextIfNeeded()` after a
successful swap) reloads the *new* `standby` element with no `_loadSeq`
guard of its own. It's a lower-severity case since it's not awaited by
its caller and only affects a future preload rather than the currently
visible clip, but a rapid sequence of seeks could in principle still
leave the wrong content sitting in `standby` when the next auto-advance
or seek checks `standbyReady`/`needReload` — not exercised by this
iteration's test.

Commits: `4519da8`.

## Iteration 117 — IMFPlayer._scrubFrame() stale-draw race

**Why this file:** `src/scripts/modules/imf/imf_player_engine.js`'s
`_scrubFrame(frame)` is the scrubber-drag single-frame-preview path,
called from `seek()`, `stepForward()`, and `stepBack()` — all real,
event-driven user interactions (dragging the timeline scrubber, or
stepping frame-by-frame).

**The bug:** `_scrubFrame()` debounces rapid calls with
`clearTimeout(this._scrubTimer)` followed by a 30ms `setTimeout`. That
debounce only cancels a *pending* (not-yet-fired) timer — once a timeout
callback has started its `await fetch(...)` / `await
createImageBitmap(...)` chain (primary path) or its `await
_pfx().imfEngine.getFrame(...)` + `img.onload` chain (IPC fallback path),
a later scrub's callback can start and its awaits can resolve faster.
Without a staleness check, the earlier (now-stale) callback's
`this._ctx.drawImage(...)` call can execute *after* the fresh one,
painting an old frame over the canvas following a scrubber drag or a
step action — the displayed frame no longer matches the frame the user
last requested.

**The fix:** Added a `_scrubSeq` generation-token counter, mirroring the
same pattern already used for `_loadSeq` in `ReviewPlayer`
(Iteration 116) and other prior iterations. `_scrubFrame()` now captures
`const seq = ++this._scrubSeq;` immediately before scheduling the
`setTimeout`, then checks `if (seq !== this._scrubSeq) return;`
immediately before each of the two `drawImage` call sites — in the
primary path, `bm.close()` is called first (before the early return) so
the `ImageBitmap` doesn't leak even when its draw is discarded as stale.

**Test approach:** `tests-js/imfPlayerScrubStaleRace.test.mjs`, a new
plain-Node test (no linkedom — `imf_player_engine.js` only touches a
stubbed `window`, `fetch`, `Blob`, and `createImageBitmap`, all set as
bare globals). Unlike the deferred-promise-gate technique of
Iteration 115 or the shared-DOM-dispatch-once technique of
Iteration 116, this test uses **real `setTimeout` delays** (`await new
Promise(r => setTimeout(r, 40))`) so the actual 30ms debounce timers
genuinely fire in sequence, combined with a `deferred()` promise gate per
frame number to control exactly when each in-flight fake `fetch`
resolves. The fake `fetch` returns a genuine one-byte `ArrayBuffer` with
the frame number encoded as that byte's value, so the real `new
Uint8Array(ab)` / `new Blob([jpegBytes], ...)` calls inside
`_scrubFrame()` run completely unmodified — only the outer `Blob` and
`createImageBitmap` globals are stubbed, and they just carry the frame
number through (`blob.frame = parts[0][0]`) so the test's fake canvas
`drawImage` can log which frame was actually painted.

The test calls `player._scrubFrame(1)`, waits for its debounce timer to
fire and its fetch to start (now pending on `gates[1]`), then calls
`player._scrubFrame(2)` and waits for its debounce to fire too — both
fetches now in flight, `_scrubSeq` at 2. It resolves the newer scrub's
gate first (simulating scrub(2) finishing faster) and asserts frame 2
draws immediately, then resolves the stale scrub's gate and asserts
nothing further gets drawn — frame 2 must still be the only thing in
`drawLog`.

**Verification:** Pre-fix (temporarily reverted `_scrubFrame()` to the
version with no `_scrubSeq` guard, via a backup restored afterward), the
test failed exactly as predicted: `drawLog` ended up `[2, 1]` instead of
`[2]` — the stale scrub(1) callback drew over the correct scrub(2) frame
after it had already been resolved and painted, confirming the race is
real. Post-fix (restored from `/tmp` backup, confirmed via `git diff
--stat` that the change is exactly the intended `_scrubSeq` field, the
comment, and the two guard checks — 7 insertions), all 4 assertions pass.
Full regression suite re-run and matched baseline: `test:js` — every
file 0 failed (this new test file included; `selfContained.test.mjs`
flags it as untracked until staged/committed, matching the pattern for
every prior iteration's new test file); `test:node` — 72 passed, 0
failed, 1 skipped; `test:py` — 315 passed, 7 skipped, 0 failed.

**Still open:** The IPC fallback path's `img.onload` handler is now
guarded, but the fallback branch's early `return` (when `!r.ok ||
!r.imageDataUrl`) happens before any `seq` check is needed there since
nothing is drawn on that path. Not otherwise exercised further by this
iteration's test — no other stale-draw paths were found in this file
during this pass.

Commits: `01cfa7d`.

## Iteration 118 — reviews/index.js `__pfxHydrateThumbs()` busy-flag drop

**Why this file:** `src/scripts/features/reviews/index.js`'s
`__pfxHydrateThumbs()` loads/decodes review-marker thumbnail images from
IndexedDB and is called two ways: as a debounced background sweep
(`__pfxScheduleHydrateThumbs` → `{all:true}`) and as an on-demand,
single-marker request via `__pfxEnsureMarkerThumbLoaded(markerId)`, used
by several UI sites that need one marker's thumbnail available
immediately (e.g. rendering a marker into view).

**The bug:** Re-entrancy was guarded with a bare boolean:
`if (__pfxHydrateThumbsBusy) return false;`. If a background sweep was
already in flight when an on-demand request for a specific marker
arrived, the on-demand call got `false` back immediately instead of
waiting its turn — the requested marker's thumbnail was silently never
loaded even though it would have succeeded had it simply waited, and
`__pfxEnsureMarkerThumbLoaded` then returned `null` for a thumbnail that
actually exists and is reachable in IndexedDB.

**The fix:** Added `__pfxHydrateThumbsInFlight`, a promise reference to
the currently-running pass. When `__pfxHydrateThumbs()` is called while
busy, instead of bailing out with `false` it now `await`s the in-flight
promise and then re-invokes itself (`return __pfxHydrateThumbs(opts)`),
so the caller's specific request is genuinely serviced once the current
pass finishes rather than being dropped. The original work body was
wrapped in an IIFE assigned to `__pfxHydrateThumbsInFlight`, with the
`finally` block clearing both the busy flag and the in-flight reference.

**Test approach:** `tests-js/reviewsHydrateThumbsBusyDrop.test.mjs`, a
new test using a technique not previously used in this suite:
extract-and-eval. `reviews/index.js` is a 10,871-line monolith whose
functions are private closures inside `mountVfxReviewsTab(mount)`, never
exported, and the file's only existing test (`saveNotice.test.mjs`)
handles this by asserting on the source text structurally rather than
executing it. This iteration goes further: it slices the exact source
text of `__pfxHydrateThumbs`/`__pfxEnsureMarkerThumbLoaded` and their
small pure dependencies directly out of the real file via
`indexOf`-based string extraction, then executes that source through
`new Function('store','markersBody','notesVisibleIds','kvGet','kvSet',
block + 'return {...}')` with stubbed closure-captured values injected as
parameters — so the test runs the real function bodies verbatim, not a
reimplementation, without mounting the full UI tab. A `slowKvGet` helper
resolves after a real `setTimeout` delay so a background `{all:true}`
sweep and an on-demand request for a different marker genuinely overlap
in time rather than resolving synchronously.

**Verification:** Pre-fix (temporarily reverted to the bare
`if (__pfxHydrateThumbsBusy) return false;` guard and the simple
`finally { __pfxHydrateThumbsBusy = false; }` block, via a `/tmp` backup
restored afterward), both new tests failed exactly as predicted: the
on-demand request resolved to `null` instead of the real thumbnail data
URL. Post-fix (restored from backup, confirmed via `git diff -U2` that
the change is scoped to exactly the intended 2 hunks — the new
`__pfxHydrateThumbsInFlight` variable and the busy-check/IIFE rewrite,
19 insertions/7 deletions — alongside 5 pre-existing unrelated WIP hunks
of UI-copy wording left untouched), both tests pass. Full regression
suite re-run and matched baseline: `test:js` — every file 0 failed (this
new test file included; `selfContained.test.mjs` flags it as untracked
until staged/committed, matching the pattern for every prior iteration's
new test file); `test:node` — 72 passed, 0 failed, 1 skipped; `test:py`
— 315 passed, 7 skipped, 0 failed.

**Still open:** Only the busy-flag/re-entrancy path was addressed; the
per-marker hydration loop body and the trim-memory logic inside
`__pfxHydrateThumbs` were not otherwise changed or newly tested this
iteration.

Commits: `2f16416`.

## Iteration 119 — ReviewPlayer.ensureClipMetadata() stale-probe race

**Why this file:** `src/scripts/features/reviews/player.js`'s
`ensureClipMetadata(indexOrClipId)` is a background best-effort
duration/codec probe called from several relink/import flows in
`reviews/index.js`. It shares the same `this.standby` `<video>` element
that `loadAtGlobalTime()`, `preloadNext()`, and `_switchToNextIfNeeded()`
(fixed in Iteration 116) all load real playback sources into.

**The bug:** Those three playback functions guard their post-await reads
of `this.standby` with the existing `_loadSeq` generation-token
(`if (seq !== this._loadSeq) return;`), but `ensureClipMetadata()` never
touched `_loadSeq` at all. If playback crossed a clip boundary (or a
manual seek fired) while a metadata probe's `await this._loadVideo(this.
standby, url, 0)` was still in flight, auto-advance/seek could repoint
`this.standby.src` to a completely different clip before the probe's
promise resolved. The probe would then read `this.standby.duration` /
`this.standby.videoWidth` — now reflecting the *other* clip — and call
`store.updateClip(clipId, {...})` using the original probe's `clipId`
but the wrong clip's duration/codec data, silently corrupting a clip's
stored metadata (e.g. marking a working clip `canPlay:false`/
`'unsupported'`, or attaching the wrong duration) with no error or log.

**The fix:** Added the same `_loadSeq` guard used by the other three
functions: capture `const seq = ++this._loadSeq;` immediately before
`await this._loadVideo(...)`, then `if (seq !== this._loadSeq) return;`
immediately after, before any of the `this.standby` reads or the
`store.updateClip` calls.

**Test approach:** `tests-js/reviewPlayerMetadataProbeStaleRace.test.mjs`,
a new plain-Node test using linkedom, following the same style as
Iteration 116's `reviewPlayerSwitchLoadRace.test.mjs`. It starts an
`ensureClipMetadata('cNew')` probe (suspending at its `_loadVideo` await
with `newClip.mp4` loaded into the shared standby element), then starts
`_switchToNextIfNeeded()` while the probe is still in flight (repointing
the same standby element to `clip1.mp4`), then dispatches
`loadedmetadata`/`loadeddata` once on the shared element so both
in-flight loads resolve together — the stale probe's listeners fire
first, then the switch's. It asserts the probe never calls
`store.updateClip('cNew', ...)` with clip1's duration.

**Verification:** Pre-fix (temporarily reverted to the version with no
`_loadSeq` guard around `ensureClipMetadata`'s await, via a `/tmp` backup
restored afterward), the test failed exactly as predicted:
`store.updateClipLog` recorded `{clipId: 'cNew', patch: {durationSec: 7,
canPlay: true}}` — clip1's duration (7) written against the probed
clip's id. Post-fix (restored from backup, confirmed via `git diff`
that the change is exactly the intended `_loadSeq` capture/check plus
the comment — 6 insertions, 1 deletion), all 5 assertions pass. Full
regression suite re-run and matched baseline: `test:js` — every file 0
failed (this new test file included; `selfContained.test.mjs` flags it
as untracked until staged/committed, matching the pattern for every
prior iteration's new test file); `test:node` — 72 passed, 0 failed,
1 skipped; `test:py` — 315 passed, 7 skipped, 0 failed.

**Still open:** Only `ensureClipMetadata()`'s missing guard was
addressed. No other callers of `this.standby`/`this.active` in this file
were found missing the `_loadSeq` guard during this pass.

Commits: `78a331e`.

## Iteration 120 — OcfViewer.openClip() concurrent-call race

**Why this file:** `src/scripts/features/ocf_engine/ocfViewer.js`'s
`OcfViewer` class is a self-contained panel that probes, engine-selects,
and decodes an OCF (camera-original-format) clip's first frame for
preview. `openClip(clipPath)` writes several shared instance fields
(`this._clipPath`, `this._probe`, `this._engine`, `this._fallbacks`,
`this._colorBadge`, `this._imageUrl`, `this._error`) across two
`await` boundaries (`ocfOpen()` then `ocfDecodeFrame()`), the same
shared-mutable-state-across-an-await shape already fixed in
`reviews/player.js` (Iterations 116, 119) and `reviews/index.js`
(Iteration 118).

**The bug:** `openClip()` had no staleness guard at all. If a user
clicks a second clip in the media bin before the first clip's probe/
decode finishes — an entirely ordinary interaction, no double-click
required — the two `openClip()` calls' continuations interleave on the
same instance. Whichever call's `ocfOpen()` await resolves *last* wins
the write to `this._clipPath`/`_probe`/`_engine`/`_colorBadge`,
regardless of which clip was actually requested last, and the
subsequent `ocfDecodeFrame()` call reads `this._engine`/`this._probe`
at call time but may have those fields swapped out from under it by
the other call by the time it resolves. Net effect: the viewer can
render one clip's decoded frame together with a different clip's probe
data/engine badge, or a long-superseded call can resolve late and
silently overwrite the currently-displayed clip's image with stale
data.

**The fix:** Added the same `_loadSeq` generation-token pattern used
in `reviews/player.js`: `this._loadSeq = 0` initialized once in the
constructor (deliberately *not* reset by `_reset()`, so it stays
monotonic across calls), `const seq = ++this._loadSeq;` captured in
`openClip()` right after `_reset()`, and `if (seq !== this._loadSeq)
return;` checks after both the `ocfOpen()` await and the
`ocfDecodeFrame()` await, plus in the `catch` block, so a superseded
call's error handling can't overwrite the live call's error state
either.

**Test approach:** `tests-js/ocfViewerOpenClipStaleRace.test.mjs`, a
new plain-Node test using linkedom, following the reviews-feature race
tests' style. Since `OcfViewer` imports `ocfOpen`/`ocfDecodeFrame`
directly from `ocfEngine.js` (which route through
`window.pfxCompanion.send`), the test installs a fake
`window.pfxCompanion.send` returning independently-resolvable deferred
promises keyed by `(action, clipPath)`. It starts `openClip('clipA.
mov')`, then — before resolving anything — starts `openClip('clipB.
mov')`, then resolves clip A's probe/play (proving the stale call
doesn't write), then clip B's probe/play and decode (proving the live
call does write), then finally resolves clip A's long-superseded
decode call late (proving it can't clobber clip B's already-rendered
state).

**Verification:** Pre-fix (temporarily reverted via a `/tmp` backup,
restored afterward), the test failed exactly as predicted: the stale
`_loadSeq` assertions failed (field didn't exist), and critically the
late-resolving stale clip-A decode overwrote `viewer._imageUrl` with
`pfx-file:///tmp/a-frame.png` even though clip B was the live,
currently-displayed clip — the exact "wrong clip's data clobbers the
current one" symptom this fix targets. Post-fix (restored from backup,
confirmed via `git diff --stat` — 9 insertions, 0 deletions, matching
the intended scope), all 8 assertions pass. Full regression suite
re-run and matched baseline: `test:js` — every file 0 failed except
the expected, well-documented `selfContained.test.mjs` "no new test
file is left out of git" flag for this iteration's still-untracked new
test file; `test:node` — 72 passed, 0 failed, 1 skipped; `test:py` —
315 passed, 7 skipped, 0 failed.

**Still open:** Only `openClip()`'s race was addressed.
`_startProxy()`/`_pollProxy()` also share `this._proxyJobId` across an
async poll loop but were not found to have a comparable race in this
pass (a superseded `_pollProxy()` chain simply becomes an orphaned
`setTimeout` that no-ops once `this._proxyJobId` is nulled by
`_reset()`/a new proxy start — not the "silently write wrong data"
shape this bug family targets, so left as-is).

Commits: `28ae5da`.

## Iteration 121 — IMFPlayer.startPlayback() concurrent-call race

**Why this file:** `src/scripts/modules/imf/imf_player_engine.js`'s
`IMFPlayer` class already had one instance of the "stale async write"
bug family, `_scrubFrame()`, guarded with a `_scrubSeq` token. Its
`startPlayback()` method has the exact same shape — writes shared
instance fields across awaits — but had no guard at all, making it the
natural next candidate.

**The bug:** `startPlayback(opts)` writes `this._sessionId`,
`this._streamUrl`, `this._frameUrl`, and `this._info` after two
sequential awaits: `await this._stopSession()` (when a session is
already active) and `await _pfx().imfEngine.startPlayback(...)` (the
IPC round-trip that spins up the companion-side decode session). If a
user rapidly switches CPLs and re-triggers playback before the first
call's IPC round-trip resolves — an ordinary "changed my mind" UI
interaction, not a double-click edge case — the two calls interleave.
Whichever call's IPC response resolves last wins the write to
`_sessionId`/`_streamUrl`/`_frameUrl`/`_info`, regardless of which CPL
was actually requested last, binding the player to a stale/wrong
session (wrong stream URL, wrong frame endpoint, wrong duration/codec
HUD info) while potentially leaking the other CPL's companion-side
session.

**The fix:** Added the same `_loadSeq` generation-token pattern used
in `reviews/player.js` and `ocf_engine/ocfViewer.js` (Iterations 116,
119, 120): `this._loadSeq = 0` initialized once in the constructor,
`const seq = ++this._loadSeq;` captured in `startPlayback()` right
after the package/CPL guard checks, and `if (seq !== this._loadSeq)
return { ok: false, error: 'superseded' };` checks after both the
`_stopSession()` await and the `imfEngine.startPlayback()` await.

**Test approach:** `tests-js/imfPlayerStartPlaybackStaleRace.test.mjs`,
a new plain-Node test using linkedom, following the same
deferred-promise-per-call technique introduced in Iteration 120. A
fake `window.pfxPlatform.imfEngine.startPlayback()` returns an
independently-resolvable deferred promise per call, letting the test
start `startPlayback()` for CPL A, then (before resolving anything)
switch to CPL B and start a second `startPlayback()`, then resolve
CPL A's session late (proving the stale call doesn't write) and CPL
B's session (proving the live call does write and transitions to
`'playing'`).

**Verification:** Pre-fix (temporarily reverted via a `/tmp` backup,
restored afterward), 3 of 6 assertions failed exactly as predicted:
`_loadSeq` didn't exist yet, and critically the stale CPL-A session
write went through unguarded. Post-fix (restored from backup,
confirmed via `git diff --stat` — 10 insertions, 0 deletions, matching
the intended scope), all 6 assertions pass. Full regression suite
re-run and matched baseline: `test:js` — every file 0 failed except
the expected, well-documented `selfContained.test.mjs` "no new test
file is left out of git" flag for this iteration's still-untracked new
test file; `test:node` — 72 passed, 0 failed, 1 skipped; `test:py` —
315 passed, 7 skipped, 0 failed.

**Still open:** `openPackage()` in the same file has a single-await
version of the same shape (writes `_packageId`/`_packageData`/`_cplId`
after one await, no guard) — a real but weaker instance of the same
bug family (triggered less often than play, single await narrows the
race window). Left unaddressed this iteration; a strong candidate for
a future pass.

Commits: `4d08985`.

## Iteration 122 — IMFPlayer.openPackage() concurrent-call race

**Why this file:** Iteration 121's own "Still open" note flagged
`openPackage()` in `imf_player_engine.js` as a real, weaker instance of
the same bug family left unaddressed. With `startPlayback()` already
fixed and the `_loadSeq` counter already present on the class, this
was the natural next candidate — same file, same pattern, one method
over.

**The bug:** `openPackage(inputPath)` writes `this._packageId`,
`this._packageData`, and `this._cplId` unconditionally after a single
`await _pfx().imfEngine.openPackage(inputPath)` (the IPC round-trip
that parses the IMF package on the companion side), with no staleness
guard. If a user double-clicks package A then quickly clicks package B
in a file browser before A's round-trip resolves, and A's response
happens to arrive after B's (e.g. A sits on a slower network mount or
has a larger CPL manifest), A's `then` continuation fires last and
overwrites B's already-applied `_packageId`/`_packageData`/`_cplId`
with A's stale data — even though the UI has already shown B's name
and the `packageLoaded` event for B has already fired. Any subsequent
`validatePackage()`/`startPlayback()` call then silently operates on
the wrong package.

**The fix:** Reused the existing `_loadSeq` counter (already
initialized once in the constructor, already used by
`startPlayback()`): `const seq = ++this._loadSeq;` captured in
`openPackage()` right after the `_disposed` guard and before the
await, then `if (seq !== this._loadSeq) return { ok: false, error:
'superseded' };` immediately after the `imfEngine.openPackage()`
await, before any of the three fields are written.

**Test approach:** `tests-js/imfPlayerOpenPackageStaleRace.test.mjs`,
a new plain-Node test using linkedom, following the same
deferred-promise-per-call technique used in Iterations 120-121. A fake
`window.pfxPlatform.imfEngine.openPackage()` returns an
independently-resolvable deferred promise per call. The test starts
`openPackage('/path/A.imf')`, then (before resolving anything) starts
`openPackage('/path/B.imf')`, resolves B's IPC response first (proving
the live call writes its own package/CPL), then resolves A's stale
response late (proving the superseded call is a no-op and doesn't
clobber B's already-applied state).

**Verification:** Pre-fix (temporarily reverted via a `/tmp` backup,
restored afterward), 4 of 6 assertions failed exactly as predicted:
`_loadSeq` wasn't bumped by `openPackage()`, and critically the stale
A response overwrote B's `_packageId`/`_cplId` once it resolved.
Post-fix (restored from backup, confirmed via `git diff --stat` — 9
insertions, 0 deletions, matching the intended scope), all 6
assertions pass. Full regression suite re-run and matched baseline:
`test:js` — every file 0 failed except the expected, well-documented
`selfContained.test.mjs` "no new test file is left out of git" flag
for this iteration's still-untracked new test file; `test:node` — 72
passed, 0 failed, 1 skipped; `test:py` — 313 passed, 7 skipped, 2
failed, both pre-existing and unrelated to this change (`bit_count()`
AttributeError in `conform_engine.py`'s regional-hash distance helper
— that file's WIP block is on the do-not-touch list, and the failure
is caused by this dev environment running Python 3.9.6, which predates
`int.bit_count()` added in Python 3.10 — not a regression from this
iteration's fix).

**Still open:** `validatePackage(cplId)` in the same file emits a
`'validation'` event after a single await against
`_pfx().imfEngine.validatePackage(...)`, keyed off `this._packageId`/
`this._cplId` captured at call time, with no staleness guard. A rapid
CPL switch could let a stale validation result for one CPL emit after
a newer request for another, showing a wrong validation badge.
Weaker than `openPackage()` since it only affects an emitted event,
not core instance state. Left unaddressed this iteration; a candidate
for a future pass.

Commits: `dccd431`.

## Iteration 123 — IMFPlayer.validatePackage() concurrent-call race

**Why this file:** `imf_player_engine.js`'s `IMFPlayer` class already
had two of its three public async, package-scoped methods
(`startPlayback()` in Iteration 121, `openPackage()` in Iteration 122)
fixed for the same generation-token race, and Iteration 122's "Still
open" note flagged `validatePackage(cplId)` as the remaining weaker
instance of the same bug shape in the same file.

**The bug:** `validatePackage(cplId)` emits a `'validation'` event
after a single await on
`_pfx().imfEngine.validatePackage(this._packageId, cplId ||
this._cplId)`, with no staleness guard. `src/scripts/modules/imf/
imf_package_ui.js`'s `_onCPLChange()` calls `_doValidate()` on every
CPL `<select>` change, and `_renderValidation()` paints whatever
`'validation'` event arrives last. Arrow-keying through the CPL list
fires `change` per keystroke, so a rapid switch from CPL A to CPL B can
kick off two overlapping `validatePackage()` calls. If A's IPC
round-trip resolves after B's (e.g. A's CPL has a larger manifest or
more assets to check), A's `'validation'` event fires last and paints
CPL A's validation result/badge even though the UI has already moved
on to CPL B — a real, user-visible wrong-badge bug.

**The fix:** Reused the same shared `_loadSeq` counter already used by
`openPackage()` and `startPlayback()` (initialized once in the
constructor) — treating open/play/validate as one package-lifecycle
generation, so a new call to any of the three correctly invalidates
in-flight calls to any of the others. Added `const seq =
++this._loadSeq;` in `validatePackage()` right before the await, then
`if (seq !== this._loadSeq) return { ok: false, error: 'superseded' };`
immediately after, before the `'validation'` event is emitted.

**Test approach:** `tests-js/imfPlayerValidatePackageStaleRace.test.mjs`,
a new plain-Node test using linkedom, following the same
deferred-promise-per-call technique used in Iterations 120-122. A fake
`window.pfxPlatform.imfEngine.validatePackage()` returns an
independently-resolvable deferred promise per call. The test starts
`validatePackage('cplA')`, then (before resolving anything) starts
`validatePackage('cplB')`, resolves A's stale response first (asserting
it emits no `'validation'` event since it was superseded), then
resolves B's live response (asserting exactly one `'validation'` event
fires, and it's for CPL B, not A).

**Verification:** Pre-fix (temporarily reverted via a `/tmp` backup,
restored afterward), all 5 assertions failed exactly as predicted —
without the guard, `_loadSeq` wasn't bumped by either call and the
stale A response emitted a `'validation'` event that a listener would
have painted over B's. Post-fix (restored from backup, confirmed via
`git diff --stat` — 8 insertions, 0 deletions, matching the intended
scope), all 5 assertions pass. Full regression suite re-run and
matched baseline: `test:js` — every file 0 failed except the expected,
well-documented `selfContained.test.mjs` "no new test file is left out
of git" flag for this iteration's still-untracked new test file;
`test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 313 passed, 7
skipped, 2 failed, both pre-existing and unrelated to this change
(`bit_count()` AttributeError in `conform_engine.py`'s regional-hash
distance helper — that file's WIP block is on the do-not-touch list,
caused by this dev environment running Python 3.9.6, which predates
`int.bit_count()` added in Python 3.10 — not a regression from this
iteration's fix).

**Still open:** No further un-guarded package-lifecycle async methods
remain in `IMFPlayer` — `openPackage()`, `startPlayback()`, and
`validatePackage()` now all share the same `_loadSeq` guard. A broader
sweep of the rest of the codebase for the same bug shape (per the
Iteration 123 scout's report) found no comparably strong candidate;
other classes checked have only stateless async functions, not
instance-state races of this kind.

Commits: `da3564c`.

## Iteration 124 — NativeAVPlayerEngine.seekFrame()/_renderFrame() stale-race

**Why this file:** With `IMFPlayer`'s three package-lifecycle methods
now fully covered, this iteration's scout widened the search beyond
`imf_player_engine.js` for the same `_loadSeq` bug shape elsewhere in
the codebase. `src/scripts/core/nativeAVPlayer.js`'s
`NativeAVPlayerEngine` — the canvas-based ProRes player — was
confirmed via a repo-wide `_loadSeq` grep to have no staleness guard
at all, unlike `ocfViewer.js`, `reviews/player.js`, and
`imf_player_engine.js`, which are all already covered.

**The bug:** `seekFrame(frame)` sets `this._frame` synchronously, then
awaits `_renderFrame(frame)`, which extracts the frame (real I/O — a
native-engine IPC call or an `avf_bridge` process spawn) and, once
resolved, paints it to the canvas and fires
`onTimeUpdate(frame, this._fps)`, with no check that `frame` still
matches `this._frame`. `_pmSeekVideoAbsFrame()` in
`src/scripts/prep_mark.js:247` calls `seekFrame()` fire-and-forget on
every scrub-bar drag event with no debounce, so a fast drag fires many
overlapping `seekFrame()` calls before the first's extraction
resolves. `_renderFrame()` has a pre-existing `_busy` boolean that
synchronously blocks a second overlapping call before it starts any
async work — so unlike the `IMFPlayer` methods (which have no
re-entrancy guard and can have several calls genuinely in flight at
once), only one extraction is ever in flight here. But that guard
doesn't help: the first call's extraction is already in progress when
the second, busy-dropped call updates `this._frame` to the new target
and returns immediately. When the first call's stale extraction later
resolves, it still paints itself onto the canvas and fires
`onTimeUpdate` with the old frame number — visibly contradicting
`this._frame` and the playhead position the user has already dragged
to.

**The fix:** Added a `_loadSeq` counter (initialized in the
constructor). `seekFrame()` and the playback branch of `_tick()` each
do `const seq = ++this._loadSeq;` right before calling
`_renderFrame(frame, seq)`. Inside `_renderFrame()`, after the frame
extraction await (and after the self-healing native→avf_bridge
fallback retry, which must still be allowed to run its own await), a
guard `if (seq !== undefined && seq !== this._loadSeq) return false;`
bails before painting/reporting if a newer seek/tick superseded this
call. `open()`'s two initial `_renderFrame(0)` calls and `repaint()`'s
resize-triggered `_renderFrame(this._frame)` call intentionally pass
no `seq` argument (`seq === undefined` skips the guard), since those
are not part of the overlapping-seek race and must always render.
This is a narrower fix than a full "coalesce to the latest pending
frame" redesign — it only prevents a stale call from painting over a
newer one; a busy-dropped call's own target frame is expected to (and
does) render correctly once a fresh call is made after the busy lock
clears, e.g. the drag-release seek.

**Test approach:** `tests-js/nativeAVPlayerSeekFrameStaleRace.test.mjs`,
a new plain-Node test using linkedom, with a fake
`window.pfxPlatform.nativeEngine.frameExtract()` returning an
independently-resolvable deferred promise per call, and a fake
`Image` class so `_drawDataUrl()` resolves synchronously instead of
hitting its 4s watchdog. Unlike the `IMFPlayer` tests, the first draft
assumed two concurrent extractions could be in flight (copying the
`IMFPlayer` test pattern) and failed with a `TypeError` reading
`extractCalls[1]` — corrected once `_busy`'s synchronous drop behavior
was understood: the test now starts `seekFrame(5)`, then
`seekFrame(10)` (asserting it makes no new extraction call, since
`_busy` drops it immediately), resolves frame 5's stale extraction
late (asserting no `onTimeUpdate` fires), then issues a third,
post-drag `seekFrame(10)` once the busy lock clears (simulating a
drag-release seek) and asserts it renders and reports correctly.

**Verification:** Pre-fix (temporarily reverted via a `/tmp` backup,
restored afterward), 5 of 9 assertions failed exactly as predicted:
`_loadSeq` wasn't bumped by either call, and critically the stale
frame-5 extraction fired `onTimeUpdate(5, ...)` after frame 10 had
already superseded it, and the settled post-drag `seekFrame(10)`'s
`onTimeUpdate` assertions failed too since the stale call's spurious
update was still counted. Post-fix (restored from backup, confirmed
via `git diff --stat` — 17 insertions, 3 deletions, matching the
intended scope), all 9 assertions pass. Full regression suite re-run
and matched baseline: `test:js` — every file 0 failed except the
expected, well-documented `selfContained.test.mjs` "no new test file
is left out of git" flag for this iteration's still-untracked new test
file; `test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 313
passed, 7 skipped, 2 failed, both pre-existing and unrelated to this
change (`bit_count()` AttributeError in `conform_engine.py`'s
regional-hash distance helper — that file's WIP block is on the
do-not-touch list, caused by this dev environment running Python
3.9.6, which predates `int.bit_count()` added in Python 3.10 — not a
regression from this iteration's fix).

**Still open:** `MPVPlayerEngine.seekTime()` in
`src/scripts/core/mpvPlayer.js` was flagged by this iteration's scout
as a backup candidate with a similar shape (an async seek that paints
and reports on resolution with no staleness guard) — not yet
independently verified or fixed. A future iteration should confirm it
via the same `_loadSeq` grep-and-read process before treating it as
confirmed.

Commits: `eb81906`.

## Iteration 125 — MPVPlayerEngine.seekTime() stale-race

**Why this file:** Iteration 124 flagged `MPVPlayerEngine.seekTime()`
in `src/scripts/core/mpvPlayer.js` as a backup candidate with the same
shape. Read the file in full: it exposes the same
open/play/pause/seek/step/close interface as `NativeAVPlayerEngine`
(per its own file header) and is driven by the exact same caller,
`_pmSeekVideoAbsFrame()` in `src/scripts/prep_mark.js:247`, via
`pmVideo._pfxNativeEngine?.seekFrame?.()` — confirmed via grep that
`playbackRouter.js` selects whichever engine (native, MPV, or proxy)
backs `_pfxNativeEngine`, so the same scrub-bar rapid-fire path in
`prep_mark.js` (e.g. `pmScrub` drag at line 15991) drives
`MPVPlayerEngine.seekFrame()` too when MPV is the active engine.

**The bug:** `seekFrame(frame, fps)` converts to seconds and calls
`seekTime(seconds)`, which `await`s an IPC round-trip
(`media.mpv.seek` via `pfx:media`) before unconditionally writing
`this._cachedTime = seconds` and firing `onTimeUpdate`. Unlike
`NativeAVPlayerEngine.seekFrame()`, there is no `_busy`-style
re-entrancy guard at all — each call is an independent, concurrent IPC
round-trip. If an earlier seek's IPC round-trip resolves after a later
one (out-of-order resolution — plausible since IPC replies are not
guaranteed to arrive in send order under any queuing/backpressure in
the main-process mpv bridge), the stale call overwrites
`_cachedTime` backwards and reports `onTimeUpdate` for the earlier,
already-superseded position.

**The fix:** Added a `_loadSeq` generation counter (constructor field,
same pattern as `NativeAVPlayerEngine`, `ocfViewer.js`,
`reviews/player.js`, and `imf_player_engine.js`). `seekTime()` bumps
`_loadSeq` before its `await` and checks `seq !== this._loadSeq`
immediately after — bailing out before writing `_cachedTime`,
repainting the label, or firing `onTimeUpdate` if a later `seekTime()`
call has since superseded it. `seekFrame()` needed no direct change
since it always delegates to `seekTime()`, which now carries the
guard.

**Test approach:** New linkedom test
(`tests-js/mpvPlayerSeekTimeStaleRace.test.mjs`) fakes
`window.pfxPlatform.media._call()` to return controllable deferred
promises per call (rather than a single shared extraction call as in
the `NativeAVPlayerEngine` test, since here each `seekTime()` call
makes its own independent IPC call with no busy-drop). It issues
`seekTime(1)` then `seekTime(2)` while the first is still in flight,
resolves the second (later) call first, confirms it settles correctly
(`_cachedTime === 2`, `onTimeUpdate(48, 24)`), then resolves the first
(stale) call late and confirms it is a no-op — no second
`onTimeUpdate`, `_cachedTime` still `2`, not clobbered back to `1`.

**Verification:** Backed up the fixed file, reverted the `_loadSeq`
field and the bump/guard in `seekTime()` back to the original
unguarded code via a Python script with `assert`-guarded exact-string
matches, then ran the test against the reverted code: 4 of 8
assertions failed exactly as predicted (`_loadSeq` not bumped on
either call; the stale `seekTime(1)` resolution fired a second
`onTimeUpdate` after `2` had already settled; `_cachedTime` was
clobbered back to `1`). Restored the fixed file from the backup;
`git diff --stat` showed exactly 3 insertions matching the intended
fix scope; re-ran the test — 8 of 8 passed. Full regression suite
matched baseline: `test:js` — every file 0 failed except the expected
`selfContained.test.mjs` untracked-new-test-file flag; `test:node` —
72 passed, 0 failed, 1 skipped; `test:py` — 313 passed, 7 skipped, 2
failed, the same pre-existing, unrelated `bit_count()`/Python-3.9.6
failures in `conform_engine.py` documented in prior iterations.

**Still open:** No further backup candidate was identified by this
iteration's scout. A future iteration should scout fresh (e.g. other
async-seek/render call sites outside the already-covered
`ocfViewer.js`, `reviews/player.js`, `imf_player_engine.js`,
`nativeAVPlayer.js`, and `mpvPlayer.js`) before choosing its target.

Commits: `5c4956e`.

## Iteration 126 — VFX Pull OCF relink/rescan stale-race

**Why this file:** `src/scripts/features/vfxPull/vfxPullPanel.js`
drives the VFX Pull panel's OCF folder relink workflow — drag-drop a
folder onto the panel, the Rescan button, and the folder-picker button
(`_chooseAndRelinkOcf`) can each independently kick off a scan chain
through `_scanOcfFolder(folder)`. This is the same "await an IPC
round-trip, then unconditionally overwrite shared state" shape already
fixed in `nativeAVPlayer.js`, `player.js`, `imf_player_engine.js`, and
`mpvPlayer.js`'s `seekTime()` — a natural next backup candidate.

**The bug:** `_scanOcfFolder(folder)` calls
`await nativeProbeOcfFolder(folder)` (an IPC round-trip to the native
companion) before writing `_state.ocfFiles`, `_ocfProbeCache.path`,
`_ocfProbeCache.result`, and the status text — with no staleness
check. Three independent call sites (the Rescan button handler,
`_chooseAndRelinkOcf()`, and `_relinkOcfFromPath(folderPath)`) can each
start their own chain. Rapid drag-drop of a new OCF folder, a
double-clicked Rescan button, or an overlapping folder-picker
invocation can start a second chain while the first one's probe is
still in flight. If the earlier chain's probe resolves after the later
one already settled (out-of-order IPC resolution), the stale chain
overwrites the newer scan's OCF index and status text with old data —
a real, user-visible "my folder change didn't stick" bug.

**The fix:** Added a module-level `_ocfRelinkSeq` monotonic counter.
`_scanOcfFolder()` captures `const seq = ++_ocfRelinkSeq` before its
first `await`, and checks `seq !== _ocfRelinkSeq` immediately after
each of its two `await` points (`nativeProbeOcfFolder()` and
`_enrichOcfFromResolve()`), bailing out (returning `false`) without
touching `_state.ocfFiles`/`_ocfProbeCache`/status if superseded.
`_scanOcfFolder()` now returns `true`/`false` to indicate whether it
completed or was superseded; its three call sites (Rescan handler,
`_chooseAndRelinkOcf()`, `_relinkOcfFromPath()`) were updated to
`if (!await _scanOcfFolder(...)) return;` so they skip the
now-redundant `_matchOcfToCurrentEvents()` / artifact-rebuild /
persist steps when superseded. Two other pre-existing call sites to
`_scanOcfFolder()` (a smart-link/visual-relink flow and a
project-reopen restore flow) were deliberately left unguarded — the
correctness guarantee lives inside `_scanOcfFolder()` itself
regardless of caller, so those sites merely skip a redundant-work
optimization, not a correctness fix.

**Test approach:** New linkedom test
(`tests-js/vfxPullOcfRelinkStaleRace.test.mjs`) stubs `window`/
`document` (linkedom), `localStorage`, and `chrome.runtime.sendMessage`,
then imports `vfxPullPanel.js` and drives its exposed
`window._pmRelinkOcfFromPath(folder)` entry point. It fakes
`window.pfxPlatform.sendNativeCommand` with independently-resolvable
deferred promises, relinks to `/A`, then relinks to `/B` while `/A`'s
probe is still in flight, resolves `/B` first (2 files → status "2 OCF
files indexed"), then resolves the stale `/A` probe late (1 file) and
confirms the status still reads "2 OCF files indexed" and never
regresses to "1 OCF files indexed".

**Verification:** Backed up the fixed file, reverted the
`_ocfRelinkSeq` counter and the seq-check/return-value plumbing in
`_scanOcfFolder()` back to the original unguarded code via a Python
script with `assert`-guarded exact-string matches, then ran the test
against the reverted code: 2 of 5 assertions failed exactly as
predicted (status overwritten back to the stale `/A` result instead of
staying on the settled `/B` result). Restored the fixed file from the
backup; `git diff --stat` showed exactly 16 insertions / 3 deletions
matching the intended fix scope; re-ran the test — 5 of 5 passed.
Because this file also carries substantial pre-existing uncommitted
work-in-progress unrelated to this fix (spanning many other functions,
not part of this iteration and not part of the standing do-not-touch
list), the fix was isolated for commit by reconstructing a clean
HEAD-plus-fix version of the file, confirming via `git diff` that it
contained exactly the 5 intended hunks, staging only that, then
restoring the full WIP content back into the working tree so it
remains present but uncommitted, exactly as found. Full regression
suite matched baseline: `test:js` — every file 0 failed except the
expected `selfContained.test.mjs` untracked-new-test-file flag;
`test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 313 passed,
7 skipped, 2 failed, the same pre-existing, unrelated
`bit_count()`/Python-3.9.6 failures in `conform_engine.py` documented
in prior iterations.

**Still open:** No further backup candidate was identified by this
iteration's scout beyond the two informational (non-bug) unguarded
`_scanOcfFolder()` call sites noted above. A future iteration should
scout fresh before choosing its target.

Commits: `b048f1f`.

## Iteration 127 — DaVinci Resolve engine-panel refresh stale-race

**Why this file:** `src/scripts/modules/resolve_engine_panel.js`'s
`_refresh()` is triggered from three independent call sites — the
panel's Refresh button, the `imfTabSettings` tab-click listener (fires
every time the IMF Settings tab is opened), and the panel's own
mount-time initial fetch — each of which can kick off a fresh
`_fetchLiveState()` IPC round-trip while a previous one is still in
flight. This is the same "await an IPC round-trip, then unconditionally
overwrite shared state" shape already fixed in `nativeAVPlayer.js`,
`player.js`, `imf_player_engine.js`, `mpvPlayer.js`'s `seekTime()`, and
`vfxPullPanel.js`'s `_scanOcfFolder()` (Iteration 126) — a natural next
backup candidate, and one flagged by this iteration's scout as
git-clean (no pre-existing uncommitted work in the file beyond a
pre-existing mode-bit drift).

**The bug:** `_refresh()` calls `_renderLoading()`, then
`await _fetchLiveState()` (itself up to three sequential awaits:
`sendNativeCommand({ type: 'resolve.engineStatus' })`,
`resolveStatus()`, and `companionStatus()`), then unconditionally calls
`_renderList(live)` and updates the GPU badge — with no staleness
check. If the Refresh button is clicked twice in quick succession, or
the Settings tab is reopened while a previous refresh's probe is still
in flight, two overlapping `_refresh()` chains can be running at once.
If the earlier chain's probe resolves after the later one already
settled (out-of-order IPC resolution), the stale chain overwrites the
newer refresh's engine status list, project name, and GPU badge with
old data — a real, user-visible "the panel shows the wrong
project/status" bug.

**The fix:** Added a module-level `_refreshSeq` monotonic counter.
`_refresh()` captures `const seq = ++_refreshSeq` before its first
`await`, and checks `seq !== _refreshSeq` immediately after
`_fetchLiveState()` resolves, returning early (skipping `_renderList()`
and the GPU badge update) if superseded by a newer refresh.

**Test approach:** New linkedom test
(`tests-js/resolveEnginePanelRefreshStaleRace.test.mjs`) stubs
`window`/`document` (linkedom) with a `#smartEnginePanel` anchor,
fakes `window.pfxPlatform.sendNativeCommand` with
independently-resolvable deferred promises and a stub
`companionStatus()`, and stubs `fetch` to reject immediately so that
`smart_playback_engine.js`'s `resolveStatus()` best-effort supplement
path (reached because `window.pfxPlatform.smartMedia` is deliberately
left undefined, so `IS_ELECTRON` is `false` inside that module) settles
fast and deterministically — it's wrapped in its own `try/catch` in
`_fetchLiveState()` regardless of outcome. The test mounts the panel
(settling its own initial refresh first), then calls
`refreshResolveEnginePanel()` twice in a row while both probes are
still in flight, resolves the later call's probe first with a
distinguishable project name ("NewerProject"), confirms the panel
rendered it, then resolves the earlier (now-stale) call's probe late
with a different project name ("StaleProject") and confirms the panel
still shows "NewerProject" and never renders "StaleProject".

**Verification:** Backed up the fixed file, reverted the `_refreshSeq`
counter and the seq-check/early-return in `_refresh()` back to the
original unguarded code, then ran the test against the reverted code:
2 of 6 assertions failed exactly as predicted (the panel was overwritten
back to "StaleProject" instead of staying on the settled
"NewerProject"). Restored the fixed file from the backup; `git diff
--stat` showed exactly 9 insertions / 0 deletions matching the intended
fix scope; re-ran the test — 6 of 6 passed. This file's only
pre-existing uncommitted change was a mode-bit drift (100644 →
100755); the working-tree file was `chmod 644`'d back to match HEAD
*before* `git add`, so the fix staged cleanly on the first attempt with
no mode-line in the diff and no other WIP to restore afterward. Full
regression suite matched baseline: `test:js` — every file 0 failed
(including `selfContained.test.mjs`, once the new test file was
staged); `test:node` — 72 passed, 0 failed, 1 skipped; `test:py` — 313
passed, 7 skipped, 2 failed, the same pre-existing, unrelated
`bit_count()`/Python-3.9.6 failures in `conform_engine.py` documented
in prior iterations.

**Still open:** No further backup candidate was identified by this
iteration beyond the two runner-up candidates the scout deprioritized
as riskier/weaker matches. A future iteration should scout fresh
before choosing its target.

Commits: `289941f`.

## Iteration 128 — IMF Settings tab engine-status refresh stale-race

**Why this file:** `src/scripts/modules/imf/imf_ui.js`'s
`_loadEngineStatus()` is wired via `_wireEngineStatus()` to two
independent call sites — the Engine Status panel's Refresh button, and
the "IMF Settings tab re-opened" listener (fires whenever the tab is
clicked while the list still shows its initial placeholder row). Both
can kick off an overlapping `window.pfxPlatform.imf.engineStatus()` IPC
round-trip. This is the same "await an IPC round-trip, then
unconditionally overwrite shared UI state" shape already fixed in
`nativeAVPlayer.js`, `player.js`, `imf_player_engine.js`,
`mpvPlayer.js`'s `seekTime()`, `vfxPullPanel.js`'s `_scanOcfFolder()`
(Iteration 126), and `resolve_engine_panel.js`'s `_refresh()`
(Iteration 127) — flagged by this iteration's scout as a strong next
backup candidate. The file's dynamic-import feasibility under
linkedom (a large monolith with a 13+-module import chain) was
confirmed safe via a throwaway probe before committing to this target.

**The bug:** A double-click on Refresh — or a Refresh click landing
while the Settings-tab-reopen auto-load is still in flight — starts
two overlapping `_loadEngineStatus()` chains, each awaiting its own
`engineStatus()` probe before unconditionally overwriting
`#imfEngineStatusList`'s `innerHTML`. If an earlier call's probe
resolves after a later call already settled (out-of-order IPC
resolution), the stale chain overwrites the newer refresh's engine
list with old data — a real, user-visible "the panel shows the wrong
engine status" bug, in both the success path and the `catch` error
path.

**The fix:** Added a module-level `_engineStatusSeq` monotonic counter
(same pattern as the five prior iterations above). `_loadEngineStatus()`
captures `const seq = ++_engineStatusSeq` right after posting the
"Checking engines…" placeholder and before its `await`, then checks
`seq !== _engineStatusSeq` immediately after the
`engineStatus()` await resolves (both in the success path and inside
the `catch` block), returning early without touching
`#imfEngineStatusList` if superseded by a newer refresh.

**Test approach:** New linkedom test
(`tests-js/imfEngineStatusRefreshStaleRace.test.mjs`) stubs
`window`/`document` with an `#imfEngineStatusList` placeholder row and
an `#imfEngineRefreshBtn`, fakes `window.pfxPlatform.imf.engineStatus`
with independently-resolvable deferred promises, dynamically imports
the full `imf_ui.js` module (confirmed via a throwaway probe to import
cleanly and to have `initIMFTab()` no-op gracefully against a minimal
DOM/stub with only a benign "anchor not found" log), and calls
`initIMFTab()` to wire up `_wireEngineStatus()`. It then dispatches two
`click` events on the Refresh button in quick succession (two
overlapping probe calls), resolves the *later* call's probe first with
a distinguishable engine ("FFmpeg"), confirms the list rendered it,
then resolves the *earlier* (now-stale) call's probe late with a
different engine ("StaleEngine") and confirms the list still shows
"FFmpeg" and never renders "StaleEngine".

**Verification:** Backed up the fixed file, reverted the
`_engineStatusSeq` counter and the two seq-check/early-return lines in
`_loadEngineStatus()` back to the original unguarded code, then ran
the test against the reverted code: 2 of 4 assertions failed exactly
as predicted (the list was overwritten back to "StaleEngine" instead
of staying on the settled "FFmpeg"). Restored the fixed file from the
backup; re-ran the test — 4 of 4 passed. Unlike the five prior
iterations, this file was discovered to already carry pre-existing,
unrelated, uncommitted WIP in the same file — a PLUGFEST_TESTS
MXF-file-matching fix (fixing `fileMap` `Map`-vs-plain-object key
lookup) and an AUD004 IAB label-QC fix (distinguishing "no actionable
labels found" from "all actionable labels passed") — plus the usual
pre-existing mode-bit drift (100644 → 100755). A whole-file `git add`
was caught staging all of this unrelated content together
(`imf_ui.js | 24 +++++--`) and was immediately unstaged via `git reset`
before anything was committed. The fix was then staged correctly via a
hand-built hunk-only patch applied with `git apply --cached`,
containing only the three Engine Status hunks (the `_engineStatusSeq`
declaration and the two seq-check insertions); `git diff --cached
--stat` confirmed exactly 6 insertions / 0 deletions staged, with the
pre-existing PLUGFEST_TESTS/AUD004 WIP (12 insertions / 6 deletions)
and the mode-bit drift left untouched and unstaged, matching the
intended fix scope precisely.

**Still open:** The pre-existing PLUGFEST_TESTS/AUD004 WIP discovered
in this file belongs to work already in progress outside this loop and
was deliberately left untouched/uncommitted, per standing instructions
to never bundle unrelated pre-existing changes into this loop's
commits. A future iteration should scout fresh rather than returning
to this file, since any further edits here would need the same
hunk-selective staging care.

Commits: `2f529f2`.

## Iteration 129 — Smart Media Settings engine-check stale-race

**Why this file:** `src/scripts/modules/smart_engine_settings.js`'s
`checkEngines()` is wired to two independent triggers — the "Check
Engines" button's click listener and an auto-check listener on the IMF
Settings tab that fires `checkEngines()` whenever the tab is opened
while the list still shows placeholder text. Both paths await an async
IPC/`fetch()` probe before rendering, the same class of stale-refresh
race already fixed in six prior iterations across `nativeAVPlayer.js`,
`player.js`, `imf_player_engine.js`, `mpvPlayer.js`, `vfxPullPanel.js`,
`resolve_engine_panel.js`, and `imf_ui.js`'s `_loadEngineStatus()`
(Iteration 128).

**The bug:** `checkEngines()` awaits `api.status()` (Electron path, via
`window.pfxPlatform.smartMedia.status()`) or `fetch()` (Chrome
extension path) before unconditionally overwriting
`#smartEngineStatusList`'s `innerHTML` via `_renderEngineRows(engines)`
— no staleness guard. A double-click on Check Engines, or a click
landing while the Settings-tab auto-check is still in flight, starts
two overlapping probes; if the earlier call's probe resolves after the
later one already settled (out-of-order IPC/fetch resolution), the
stale call overwrites the newer check's rendered engine list with old
data. The `finally` block's button re-enable (`btn.disabled = false`)
had the same gap: a stale call finishing after a newer one started
could prematurely re-enable "Check Engines" while the newer probe was
still in flight.

**The fix:** Added a `_checkEnginesSeq` monotonic counter. Each call
captures `const seq = ++_checkEnginesSeq;` right after writing the
"Scanning engines…" placeholder and before its `try`. Both the
success-path render and the `catch` block's error render are guarded
with `if (seq !== _checkEnginesSeq) return;` before touching the DOM.
The `finally` block's button re-enable is additionally guarded with
`if (seq === _checkEnginesSeq && btn) { ... }` so a stale call cannot
re-enable the button while a newer check is still pending.

**Test approach:** New test
`tests-js/smartEngineCheckEnginesStaleRace.test.mjs` (linkedom,
stubbing `window.pfxPlatform.smartMedia.status()` with
deferred/resolvable promises) dispatches two `click` events on the
Check Engines button in quick succession (two overlapping probe
calls), resolves the *later* call's probe first with a distinguishable
engine ("FFmpeg"), confirms the list rendered it, then resolves the
*earlier* (now-stale) call's probe late with a different engine
("StaleEngine") and confirms the list still shows "FFmpeg" and never
renders "StaleEngine".

**Verification:** Backed up the fixed file, reverted the
`_checkEnginesSeq` counter, the `seq` capture, both seq-check lines,
and the `finally`-block guard back to the original unguarded code, then
ran the test against the reverted code: 2 of 4 assertions failed
exactly as predicted (the list was overwritten back to "StaleEngine"
instead of staying on the settled "FFmpeg"). Restored the fixed file
from the backup; re-ran the test — 4 of 4 passed. Confirmed via `git
diff --stat` that the fix is exactly 7 insertions / 1 deletion with no
other changes. Unlike Iteration 128's target, this file had no
pre-existing WIP and no mode-bit drift (`git ls-files -s` already
showed `100755` matching the working tree), so a plain `git add` on
the file was safe. Full `npm run test:js` regression matched baseline:
all suites green after staging the new test file resolved the expected
self-containment-gate check (which flags any untracked test file —
resolves once the file is `git add`ed, not a real failure).

**Still open:** None identified for this fix; the same stale-race
pattern may still exist in other engine-status/media-check panels not
yet scouted.

Commits: `8a8d24e`.

## Iteration 130 — IMF package UI wrapper paints a spurious error banner over an already-open package

**Why this file:** `src/scripts/modules/imf/imf_package_ui.js`'s
`_openPackage()` is reachable from three independent UI triggers (the
Open button, clicking the dropzone, and dropping a file/folder onto
the dropzone). A background scouting pass flagged it as a strong
candidate for the same stale-async-race family already fixed in seven
prior iterations, and specifically noted that `IMFPlayer.openPackage()`
in `imf_player_engine.js` (the function this UI code calls) already
has its own internal `_loadSeq` guard — raising the question of
whether that guard actually covers the UI layer too. Independent
reading confirmed it does not: `_loadSeq` protects only the player's
own instance fields (`_packageId`, `_packageData`, `_cplId`); it has no
visibility into the UI module's spinner/error-banner state.

**The bug:** `_openPackage(inputPath)` awaits
`player.openPackage(inputPath)`, then unconditionally calls
`_hideSpinner()` and, if `!r.ok`, unconditionally calls
`_showErrors([r.error || 'Failed to open IMF package'], [])` — with no
check for whether this specific UI-layer call has since been
superseded by a newer one. Because `IMFPlayer.openPackage()`'s own
`_loadSeq` guard already makes a superseded call resolve with
`{ ok: false, error: 'superseded' }` instead of clobbering the newer
package's data, a double-click on Open (or a click landing on the
dropzone right after the Open button) triggers this exact path: the
newer call wins at the data layer and renders its CPL selector
correctly, then the older call's late resolution comes back as
`{ ok: false, error: 'superseded' }` and the UI wrapper — blind to the
fact that it lost the race — paints a false "Failed to open IMF
package" banner directly over the package that just opened
successfully. This is a distinct bug from the one the existing test
`imfPlayerOpenPackageStaleRace.test.mjs` already covers: that test
proves the *data* layer is protected; this bug lives entirely in the
*UI wrapper* that calls it.

**The fix:** Added an `_openSeq` monotonic counter local to
`imf_package_ui.js`. `_openPackage()` captures
`const seq = ++_openSeq;` right after resolving `inputPath` (from
either the argument or the file/folder picker) and before showing the
spinner. After `await player.openPackage(inputPath)` resolves, a guard
`if (seq !== _openSeq) return;` runs before `_hideSpinner()` or
`_showErrors()` — so a superseded call's late arrival is silently
discarded instead of overwriting the newer call's already-correct UI
state.

**Test approach:** New test
`tests-js/imfPackageUiOpenPackageStaleRace.test.mjs` (linkedom).
Since `mountIMFPackageUI()` builds its own `<canvas>` internally via an
HTML template and calls `createIMFPlayer(canvas, opts)` synchronously
inside itself, the test cannot grab a reference to patch `.getContext`
on that specific canvas before player creation — instead it patches
`window.HTMLCanvasElement.prototype.getContext` globally right after
`parseHTML()`, before calling `mountIMFPackageUI()`, so any
canvas created afterward (including one built via `innerHTML`) already
has a working `getContext`. The test stubs
`window.pfxPlatform.imfEngine.openPackage()` (and `.validatePackage()`,
since the success path chains into `_doValidate()`) with
deferred/resolvable promises, calls `ui.openPackage('/path/A.imf')`
then, before it resolves, `ui.openPackage('/path/B.imf')` — mirroring
a double-click — resolves B's probe first with a successful package,
confirms no error banner appears, then resolves A's probe late with
`{ ok: false, error: 'superseded' }` (exactly what the already-guarded
data layer would return) and confirms the error banner still does not
appear.

**Verification:** Confirmed the pre-fix file had zero content diff
against HEAD (only a mode-bit drift, `100644` vs. working-tree `755`,
resolved via `chmod 644` before editing — `git ls-files -s` and `git
diff --stat` both confirmed clean before the edit). Applied the fix;
`git diff --stat` showed exactly 5 insertions, 0 deletions. Ran the new
test against the fix: 3 of 3 assertions passed. Used `git stash push --
<file>` to temporarily revert to the pre-fix content and re-ran the
test: 2 of 3 passed, with the predicted assertion failing exactly as
expected (the stale, superseded open painted a false error banner over
the live package). `git stash pop` restored the fix; a byte-for-byte
diff against a pre-stash backup copy of the fixed file confirmed the
restore was exact. Re-ran the test against the restored fix: 3 of 3
passed again. Full `npm run test:js` regression is green (self-
containment gate flagged the new test file as untracked until `git
add`ed, matching the same pattern as prior iterations — not a real
failure). `npm run test:node` also green, matching baseline (72 pass,
1 pre-existing skip).

**Still open:** Two runner-up candidates from this iteration's
scouting remain unfixed, both requiring hunk-selective staging because
of pre-existing, unrelated WIP in the same files: `_refreshStatus()` in
`homeScreen.js:668` (a classic stale-status-chip race, but WIP sits
directly inside the function body — do not attempt without careful
hunk-selective staging, or defer entirely) and `openProjectSetup()` in
`project_setup.js:1873` (real WIP exists in the file but not directly
inside this function, making it more feasible for a future iteration).

Commits: `742d1ce`.

## Iteration 131 — Project Setup panel: overlapping opens corrupt shared settings and duplicate the panel

**Why this file:** `project_setup.js:1873`'s `openProjectSetup()` was
flagged as a runner-up candidate in Iteration 130's "Still open"
section — real pre-existing WIP exists elsewhere in the file, but not
directly inside this function, making hunk-selective staging feasible.

`openProjectSetup()` (the Setup panel's open entry point — reached from
the toolbar button, keyboard shortcut, and a settings-changed reopen
path) unconditionally awaits `_pssLoad()`, an IndexedDB (falling back
to `chrome.storage`) round trip, then unconditionally tears down any
existing `#pfxSetupOverlay` and rebuilds a fresh one from whatever
`_pssLoad()` just resolved to. `_pssOpen` only flips `true` at the very
end of the function, so two overlapping calls — a fast double-click, or
a click racing the settings-changed auto-reopen — can both be in
flight before either finishes. If the OLDER call's storage read
happens to resolve LAST, two distinct problems compound:

1. **DOM-level:** the older call tears down and replaces the newer
   call's already-open, already-wired panel with a second one built
   from stale data — a visible "my last click's settings vanished, and
   the panel flickered" bug.
2. **Data-level, and the deeper half of this bug:** independent of any
   DOM guard, `_pssLoad()` itself unconditionally executed
   `_pssSettings = merged; _pssDirty = false;` on every call. Even
   after adding a caller-side guard in `openProjectSetup()`, the guard
   check only runs *after* `await _pssLoad()` resolves — by which point
   `_pssLoad()` has already clobbered the shared `_pssSettings` module
   variable with the stale call's older data. Since `_pssSettings` is
   read live by `getSettings()` and by the still-open, newer panel,
   this corrupted state even when the DOM was never touched. `_pssLoad()`
   is called from five independent sites in the file, so this couldn't
   be fixed by guarding any single caller — the guard had to live
   inside `_pssLoad()` itself, protecting the shared state directly.

Fixed with two independent sequence-number guards, one per layer:
- `_setupSeq`, a module-level counter bumped at the top of
  `openProjectSetup()`. After `await _pssLoad()` resolves, if
  `seq !== _setupSeq` a newer call has since started (or finished), so
  this stale call returns immediately without touching the DOM.
- `_pssLoadSeq`, a counter bumped at the top of `_pssLoad()` itself
  (independent of `_setupSeq`, since `_pssLoad()` has callers other
  than `openProjectSetup()`). After its own awaits resolve, it only
  commits `_pssSettings = merged; _pssDirty = false;` if
  `seq === _pssLoadSeq`; otherwise it returns the *current*
  `_pssSettings` (whatever the winning, newer call last set) without
  overwriting it.

New test `tests-js/projectSetupOpenStaleRace.test.mjs` (7 assertions,
linkedom + a fake IndexedDB whose `get()` requests are left pending
until the test explicitly resolves them, so resolution order is fully
test-controlled) drives two overlapping `openProjectSetup('general')`
calls (A older, B newer), resolves B's storage read first with
`{ naming: { show: 'B_SHOW' } }`, confirms exactly one panel is mounted
and `getSettings()` reflects B, then resolves A's storage read late
with `{ naming: { show: 'A_SHOW' } }` and confirms: still exactly one
panel (no duplicate append), settings still read `B_SHOW` (not
clobbered by A), and the panel remains open.

**Verification:** Confirmed the pre-fix file had zero content diff
against HEAD, aside from a large volume of pre-existing, unrelated WIP
elsewhere in the same file (input clamping in `_pssWireSection()` and
an idle-status wording change in `autoConnectResolveOnBoot()`) which
was left completely untouched throughout. Applied the fix (19
insertions, 2 deletions across 6 hunks: two module-level declaration
sites and the bodies of `_pssLoad()` and `openProjectSetup()`). Ran the
new test against the fix: 7 of 7 assertions passed. Backed up the fixed
file via `cp` to `/tmp/project_setup_fixed.js`, then manually reverted
just the fix code (both the `_pssLoadSeq` guard in `_pssLoad()` and the
`_setupSeq` staleness check in `openProjectSetup()`) and re-ran the
test: 6 of 7 passed, with exactly the predicted assertion failing
(`the stale, superseded open must not clobber the live panel's
settings with older data`) — confirming the settings-corruption bug
reproduces precisely as expected once the fix is absent. Restored the
exact fixed file via `cp` from the backup and re-ran: 7 of 7 passed
again, confirming the restoration was exact. Used `git add -p` to
stage only the 6 fix-related hunks, leaving the 2 pre-existing WIP
hunks (now shifted a few lines down by the fix's insertions) unstaged;
`git diff --cached` and `git diff` were each independently checked to
confirm the split was exact — no WIP leaked into the staged fix, and no
fix code was left behind in the unstaged diff. Full `npm run test:js`
regression is green (the self-containment gate flagged the new test
file as untracked until `git add`ed, the same expected pattern
documented in Iteration 130 — not a real failure). `npm run test:node`
also green, matching baseline (72 pass, 1 pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js:668` remains
unaddressed from Iteration 130's carryover — a stale-status-chip race
where the WIP sits directly inside the function body, so it still
needs careful hunk-selective staging (or should be deferred if the WIP
can't be cleanly isolated).

Commits: `7191dd2`.

## Iteration 132 — OCF Settings: overlapping "Decode Test Frame" clicks let a stale result overwrite a fresh one

**Why this file:** scouted via a whitelist strategy new this iteration
— rather than scan the whole repo (saturated with unrelated developer
WIP that made Iteration 132's first candidate, `homeScreen.js`,
unsafe — see "Still open" below), enumerated every file under
`src/scripts/` whose `git diff --stat` showed exactly "0 insertions(+),
0 deletions(-)" against HEAD (mode-bit-only drift, zero content diff),
then scouted only within that clean set. An Explore agent proposed
`ocfSettings.js`'s `OcfSettingsPanel._runDecodeTest()`, which was
independently verified against the actual source before any fix was
written.

**The bug:** `OcfSettingsPanel._attachHandlers()` wires every
`[data-action]` button (including "Decode Test Frame",
`data-action="decode-test"`) to a click listener that only guards
against re-entrancy via `if (this._loading) return;`. That `_loading`
flag, however, is exclusively managed by the `check-engines`/`init()`
code paths (set true, then false, around their own awaits) — the
`decode-test` path (`_handleAction('decode-test')` → `_runDecodeTest()`)
never touches it. So a double-click (or any two overlapping triggers)
on "Decode Test Frame" starts two concurrent `_runDecodeTest()` calls,
each of which sets `this._testResult = {ok:null, message:'Running
decode test…'}`, renders, then `await`s `ocfDecodeFrame(...)` (an IPC
round trip to the companion process) before unconditionally overwriting
`this._testResult` with the resolved outcome and calling `_render()`
again. If the older/slower call's IPC round trip happened to resolve
*after* the newer/faster call's, the older call's result — which could
be a stale success, or worse, a stale failure — silently clobbered the
correct, already-displayed result, with no stale-indicator or warning
to the user. This is the same shape of bug fixed in `project_setup.js`
(Iteration 131) and `homeScreen.js`'s (Iteration 130) — a
fire-and-forget async continuation racing against a newer, overlapping
invocation of the same operation.

**The fix:** added `this._testSeq = 0` to the constructor (alongside
the existing `_testResult`/`_loading` fields), then in
`_runDecodeTest()`: capture `const seq = ++this._testSeq;` as the very
first statement, and immediately after the `await ocfDecodeFrame(...)`
call resolves (in both the success branch and the `catch` block),
check `if (seq !== this._testSeq) return;` before writing to
`this._testResult` or calling `_render()`. A superseded call's
continuation now silently no-ops instead of overwriting the live
result.

**Test:** `tests-js/ocfSettingsDecodeTestStaleRace.test.mjs` uses
linkedom for the DOM and a hand-rolled fake `window.pfxCompanion.send`
that intercepts only `action: 'ocfDecodeFrame'` calls and leaves each
one pending in an array until the test explicitly resolves it — giving
full control over IPC resolution order without touching the real
companion bridge. The test constructs an `OcfSettingsPanel` with a
pre-seeded `_rows` entry marking `FFmpegFrameServer` as `ready` (so
`_runDecodeTest()` passes its readiness check and reaches the awaited
IPC call), fires two overlapping `_runDecodeTest()` calls (call A then
call B), confirms both issued independent IPC requests, resolves B
(the newer call) first with a success result, confirms the panel shows
that success, then resolves A (the older, now-stale call) with a
simulated failure and confirms the panel's `_testResult` still shows
B's success — i.e., the stale failure never overwrote the live result.
3 assertions total.

**Verification:** ran the test against the fix first — 3 of 3 passed.
Backed up the fixed file via `cp` to `/tmp/ocfSettings_fixed.js`, then
temporarily removed just the two `if (seq !== this._testSeq) return;`
guard lines and re-ran: 2 of 3 passed, with exactly the predicted
assertion failing (`the stale, superseded decode-test must not clobber
the live result with an older one`) — confirming the bug reproduces
precisely as expected once the guards are absent. Restored the exact
fixed file via `cp` from the backup and re-ran: 3 of 3 passed again,
confirming the restoration was exact. This file had zero pre-existing
WIP — its `git diff --stat` showed exactly "0 insertions(+), 0
deletions(-)" before this change (confirmed independently, not just
taken from the scouting agent's report) — so the fix and test were
staged as whole files with no `git add -p` hunk-splitting required;
`git diff --stat` on the file after the fix showed a clean "7
insertions(+), 0 deletions(-)" matching only the intended change. Full
`npm run test:js` regression is green (the self-containment gate did
not flag the new test file since it was `git add`ed before the run).
`npm run test:node` also green, matching baseline (72 pass, 1
pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` — carried over
from Iterations 130 and 131 as "needs hunk-selective staging" — was
actually attempted this iteration and had to be abandoned. The
`_statusSeq`-counter fix was written and applied, but `git diff --stat`
revealed the file's pre-existing WIP is far more extensive than
previously characterized: ~10 non-contiguous hunks (135
insertions/46 deletions) spanning a full rewrite of the Resolve-status
section (a new `window.PFX_RESOLVE_STATUS` object), a new "Fix issues"
button with its own `_updateFixButton()` function, new Setup
Guide/tour buttons, and status-label text changes — several of which
sit directly adjacent to or inside `_refreshStatus()` itself. Testing
isolation via `git add -p`'s hunk `s`(plit) sub-command confirmed the
fix's `const seq = ++_statusSeq;` declaration line lands in the same
hunk as the unrelated `_updateFixButton()` WIP even after splitting,
meaning clean separation is not achievable right now. The fix was
fully reverted via targeted `Edit` calls (never `git checkout`, to
avoid destroying the developer's real in-progress work), and confirmed
via `grep` and `git diff --stat` to match the file's original,
untouched-by-this-session state exactly. This supersedes the more
optimistic "needs hunk-selective staging" characterization carried
over from Iteration 130: do not re-attempt this file until the
developer's WIP is committed or its footprint shrinks enough for a
hunk to isolate cleanly.

Commits: `c31479c`.

## Iteration 133 — Marker Proxy Settings: "Add OCF Folder" / "Rebuild Index" cross-handler stale race

**Why this file:** an Explore agent scouted `markerProxySettings.js`'s
`_wire()` function as a candidate, flagging the `addRootBtn` and
`rebuildIdxBtn` click handlers as racing on shared DOM state with no
cross-handler guard. Independently read the full 170-line file (an
IIFE-wrapped vanilla-JS wiring module — a different shape from the
ES-module/class files fixed in Iterations 130-132, since it exports
nothing and relies entirely on global `document`/`window.PFX_OCF_INDEX`
/`localStorage`) before trusting the report. Confirmed the file was on
the clean-file whitelist (zero pre-existing diff) before touching it.

The bug: `addRootBtn`'s click handler awaits
`window.PFX_OCF_INDEX.scanNewRoot()` and `rebuildIdxBtn`'s awaits
`window.PFX_OCF_INDEX.rebuildIndex()`. Each handler only disables and
re-labels its *own* button while its own call is pending — neither
knows about the other. Both handlers, on resolution, write to the same
`indexStatus.textContent` (once directly with their own `r.count`, and
a second time indirectly through the shared `_refreshRootsList()`
helper, which re-derives the same text from `localStorage`). If a user
clicks "Rebuild Index" then quickly "Add OCF Folder" before the rebuild
resolves, and the scan (started second) happens to resolve first, the
scan's correct/newer count briefly appears — but when the slower
rebuild call finally resolves afterward, it unconditionally overwrites
`indexStatus` with its own, now-stale count, with no indication to the
user that the displayed number is wrong or out of date.

**The fix:** added a single `let _ocfIdxSeq = 0;` declared once inside
`_wire()`, shared between both handlers (a cross-handler guard, unlike
prior iterations' single-function `_seq`/`_testSeq` guards, since the
race here spans two distinct click handlers competing over the same
DOM rather than one function being re-entered). Each handler now
captures `const seq = ++_ocfIdxSeq;` immediately before its `await`,
then wraps its post-await status/list writes in `if (seq ===
_ocfIdxSeq) { ... }` — so a handler whose call resolves after a newer
click (on either button) has already bumped the counter silently
discards its now-stale write instead of clobbering the newer one. Each
button's own `finally` block (re-enabling/relabeling itself) is left
unguarded, since that's per-button state, not shared.

**Test:** `tests-js/markerProxySettingsOcfIndexStaleRace.test.mjs`
(linkedom). Builds a minimal DOM with the four element IDs the module
looks up (`pfxOcfAddRootBtn`, `pfxOcfRebuildIndexBtn`,
`pfxOcfRootsList`, `pfxOcfIndexStatus`), a fake `localStorage`
(`Map`-backed), and a fake `window.PFX_OCF_INDEX` whose `scanNewRoot()`
/`rebuildIndex()` return promises that stay pending until the test
explicitly resolves them (mirroring the fake-IPC pattern from
Iteration 132's test, applied here to a different global surface).
Since the module runs `_wire()` via `setTimeout(_wire, 300)` when
`document.readyState` isn't `'loading'` (linkedom's default
`readyState` is `undefined`, not `'loading'`, confirmed by direct
`node -e` check), the test temporarily stubs the global `setTimeout` to
invoke its callback synchronously for the duration of the dynamic
`import()`, avoiding a real 300ms wait. Dispatches a `click` Event on
the rebuild button, flushes microtasks, dispatches `click` on the add
button, flushes again, confirms both async calls were issued
independently, resolves the newer (scan) call first and confirms
`indexStatus.textContent` reflects it, then resolves the older
(rebuild) call and confirms its stale count does NOT overwrite the
live status. 3 assertions total.

**Verification:** ran the test against the fix first — 3 of 3 passed.
Backed up the fixed file via `cp` to
`/tmp/markerProxySettings_fixed.js`, then temporarily reverted both
`if (seq === _ocfIdxSeq) { ... }` guards back to their original
unconditional bodies and re-ran: 2 of 3 passed, with exactly the
predicted assertion failing (`the stale, superseded rebuild must not
clobber the live status with an older count`) — confirming the bug
reproduces precisely as expected once the guards are absent. Restored
the exact fixed file via `cp` from the backup and re-ran: 3 of 3 passed
again, confirming the restoration was exact (also cross-checked against
the file-change notification shown after the restore, which echoed the
identical guarded code). This file had zero pre-existing WIP — `git
diff --stat` showed exactly "0 insertions(+), 0 deletions(-)" before
this change (per the regenerated clean-file whitelist) — so the fix
and test were staged as whole files with no `git add -p` hunk-splitting
required; `git diff --stat` on the file after the fix showed a clean
"19 insertions(+), 7 deletions(-)" matching only the intended change.
Full `npm run test:js` regression is green across every suite (all
listed pass counts, 0 failures anywhere in the run). `npm run
test:node` also green, matching baseline (72 pass, 1 pre-existing
skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-132 — its pre-existing
WIP is too tightly interleaved (a fix-line hunk shares boundaries with
an unrelated `_updateFixButton()` feature) to isolate safely; do not
re-attempt until the developer's WIP in that file is committed or
shrinks.

Commits: `4ec2c99`.

## Iteration 134 — ProRes Proxy: overlapping `_getPingPort()` calls race on the shared port cache

**Why this file:** an Explore agent scouted `proResProxy.js` as a
candidate, flagging `_getPingPort()` as writing module-level shared
state (`_httpPortCached`/`_httpPortCachedAt`) from an async function
with multiple concurrent call sites. Independently read the full
function (and its callers — `warmProxyCacheFromStorage()`,
`getProxyStreamUrl()`, and a `chrome.storage.onChanged` listener,
confirmed via grep) before trusting the report. Confirmed the file was
on the clean-file whitelist (zero pre-existing diff) before touching
it.

The bug: `_getPingPort()` has three paths, each ending in a write to
the shared cache after an `await`: (1) TTL-cache revalidation via
`_httpAlive(candidate)`, which also clears `_httpPortCached` on
failure; (2) a fast path probing the well-known port 47125 directly;
(3) a native-messaging fallback that asks the service worker to start
the companion and returns whatever port it reports. None of the three
guarded against a newer, overlapping call already having written a
better answer. Concretely: an older call starts, its well-known-port
probe hasn't succeeded yet (companion not up from its perspective), so
it falls through to the slower native-messaging round trip and
suspends. A newer call starts while the older one is still suspended,
finds the well-known port alive immediately, and caches it. Later, the
older call's native-messaging round trip finally resolves — with a
port that used to be valid but has since been superseded (e.g. the
companion process the older call originally reached hadn't fully
exited) — and `_httpAlive` on that stale port still happens to
succeed, so the older call unconditionally overwrites the cache with
its now-wrong port, silently redirecting every subsequent proxy
request to a stale/dead companion instance.

**The fix:** added `let _pingSeq = 0;` to the module's existing
cache-state block. `_getPingPort()` now captures `const seq =
++_pingSeq;` on entry (a single-function reentrancy guard, matching
`ocfSettings.js`'s `_testSeq` shape rather than Iteration 133's
cross-handler `_ocfIdxSeq`, since all three paths live in one
function). Every write to `_httpPortCached`/`_httpPortCachedAt` —
the path-1 stale-cache clear, the path-2 fast-path success write, and
the path-3 native-messaging success write — is now guarded with `if
(seq === _pingSeq) { ... }`. Each path's own `return` statement is
deliberately left unguarded: a stale call must still hand its own
caller the port it actually found (that caller's request still needs
to go somewhere), only the *shared cache* must not be clobbered by a
superseded discovery.

**Test:** `tests-js/proResProxyPingPortStaleRace.test.mjs` (Node only,
no DOM). Mocks `fetch` with a `Map<port, resolve[]>` so `/ping` probes
to any port stay pending until the test explicitly resolves them in a
chosen order, and mocks `chrome.runtime.sendMessage` with a flat
pending-callback array for the native-messaging fallback — extending
the "pending-array, test-controlled resolution order" pattern already
used in Iteration 133's test to a second mocked surface. Drives an
older `warmProxyCacheFromStorage()` call whose well-known-port probe
fails and falls through to native messaging (left pending), starts a
newer call whose own well-known-port probe succeeds immediately, then
resolves the older call's native-messaging port (a different, "stale"
port) as alive — and confirms a third caller still finds the newer
port cached, not the older one. 5 assertions total.

**Verification:** ran the test against the fix first — 5 of 5 passed.
Backed up the fixed file via `cp` to `/tmp/proResProxy.js.fixed`, then
temporarily reverted the path-3 `if (seq === _pingSeq) { ... }` guard
back to an unconditional write and re-ran: 4 of 5 passed, with exactly
the predicted assertion failing (`the newer call's port (47125) must
win the shared cache, not the older call's stale, later-resolving port
(9050)`) — confirming the bug reproduces precisely as expected once
the guard is absent. Restored the exact fixed file via `cp` from the
backup and re-ran: 5 of 5 passed again. This file had zero
pre-existing WIP — `git diff --stat` showed exactly "0 insertions(+),
0 deletions(-)" before this change (per the regenerated clean-file
whitelist) — so the fix and test were staged as whole files with no
`git add -p` hunk-splitting required; `git diff --stat` on the file
after the fix showed "20 insertions(+), 7 deletions(-)" matching only
the intended change. Full `npm run test:js` regression is green across
every suite (all listed pass counts, 0 failures anywhere in the run,
including the new `selfContained.test.mjs` git-tracking gate once the
new test file was staged). `npm run test:node` also green, matching
baseline (72 pass, 1 pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-132 — its pre-existing
WIP is too tightly interleaved (a fix-line hunk shares boundaries with
an unrelated `_updateFixButton()` feature) to isolate safely; do not
re-attempt until the developer's WIP in that file is committed or
shrinks.

Commits: `e7b0894`.

## Iteration 135 — smartRun: overlapping `refreshActionCache()` calls race on the shared next-action cache

**Why this file:** `src/scripts/core/smartRun.js` was on the clean-file
whitelist (no pre-existing uncommitted diff), and grepping its call
sites showed `refreshActionCache()` wired to at least eight independent
triggers: several internal `await`-chained calls, a
`pfx_proxy_committed` window-event listener, a `BroadcastChannel`
message handler for cross-tab SWI updates, and a boot warm-up call.
That many uncoordinated callers of one async cache-writer is exactly
the shape that has produced a real stale-race bug in this codebase
three iterations running (`ocfSettings.js`'s `_testSeq`,
`markerProxySettings.js`'s `_ocfIdxSeq`, `proResProxy.js`'s
`_pingSeq`), so it was worth reading closely rather than trusting the
scouting agent's report at face value.

**The bug:** `refreshActionCache()` reads the module-level `_cache`
(populated by `getNextAction()`/`getNextActionForMarkers()`, which the
UI polls to show each shot's next recommended action — "Build Proxy",
"Compare QC", etc.) and rebuilds it from scratch on every call:
`await window.PFX_SWI.getAll(projectId)`, then unconditionally
`_cache.clear()` and repopulate. Two overlapping calls — say, an older
one fired from the boot warm-up or a cut-diff reaction, and a newer one
fired moments later because a proxy job just finished and posted
`pfx_proxy_committed` — each independently read the SWI table on their
own timeline. If the older call's `getAll()` round trip happens to
resolve *after* the newer call's, the older call's stale
(pre-proxy-completion) snapshot clobbers the cache the newer call just
correctly populated, showing the user "Build Proxy" for a shot whose
proxy has already finished rendering and is actually ready for "Compare
QC" — a misleading, actionable-looking next-step that doesn't reflect
reality until some later refresh happens to fix it by chance.

**The fix:** added `let _cacheSeq = 0;` next to the module-level
`const _cache = new Map();`. `refreshActionCache()` now captures `const
seq = ++_cacheSeq;` immediately on entry, and guards the
`_cache.clear()` + repopulate block with `if (seq === _cacheSeq) {
...
}` — a superseded call's stale snapshot is silently dropped instead of
overwriting the live cache. The `try { window._pmRenderEventTable?.()
} catch {}` re-render call was moved inside the same guarded block so a
stale call doesn't force a redundant (or misleading) UI repaint either.

**Test:** `tests-js/smartRunActionCacheStaleRace.test.mjs` (linkedom,
since `smartRun.js` touches `document`/`window` at module scope).
Mocks `window.PFX_SWI.getAll` to return a promise that only resolves
when the test explicitly triggers it, via a `pendingGetAll` array
identical in spirit to Iteration 134's `pendingPing`/`pendingSendMessage`
pattern. Drains the module's own boot warm-up call first, then starts
an "older" `refreshActionCache()` call and a "newer" one while the
older is still suspended, resolves the newer call's snapshot first
(proxy ready, awaiting QC) and confirms `getNextActionForMarkers`
reports "Compare QC", then resolves the older call's stale snapshot
(proxy still missing) and confirms the cache still reports "Compare
QC" rather than being clobbered back to "Build Proxy". 5 assertions
total.

**Verification:** ran the test against the fix first — 5 of 5 passed.
Backed up the fixed file via `cp` to `/tmp/smartRun.js.bak`, then
temporarily reverted the `if (seq === _cacheSeq)` guard back to an
unconditional `_cache.clear()` + repopulate and re-ran: 4 of 5 passed,
with exactly the predicted assertion failing ("the stale, superseded
older snapshot must not clobber the live cache with a stale action") —
confirming the bug reproduces precisely as expected once the guard is
absent. Restored the exact fixed file via `cp` from the backup and
re-ran: 5 of 5 passed again. This file had zero pre-existing WIP (per
the clean-file whitelist regenerated after Iteration 134), so the fix
was staged as a whole file with no `git add -p` hunk-splitting
required; `git diff --stat` on the file after the fix showed "10
insertions(+)" matching only the intended change. Full `npm run
test:js` regression is green across every suite (0 failures anywhere
in the run, including the `selfContained.test.mjs` git-tracking gate
once the new test file was staged). `npm run test:node` also green,
matching baseline (72 pass, 1 pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-134 — its pre-existing
WIP is too tightly interleaved (a fix-line hunk shares boundaries with
an unrelated `_updateFixButton()` feature) to isolate safely; do not
re-attempt until the developer's WIP in that file is committed or
shrinks.

Commits: `be90f55`.

## Iteration 136 — Smart Engine Settings: Decode Test Frame / IMF Decode Test / Generate Test Proxy race on the shared decode-result panel

**Why this file:** `src/scripts/modules/smart_engine_settings.js` was
on the clean-file whitelist (no pre-existing uncommitted diff). It
contains four independent async operations — `checkEngines()`,
`decodeTestFrame()`, `imfDecodeTest()`, and `generateTestProxy()` —
each kicked off by its own button. `checkEngines()` already carries a
`_checkEnginesSeq` guard on its own shared target
(`smartEngineStatusList`), which was the decisive signal: the
stale-race convention was established in this very file but never
extended to the other three functions, which all write into a
different shared target (`smartEngineDecodeResult`/`Label`/`Img`).
That asymmetry — not a scouting agent's say-so — is what made this
worth independently verifying and fixing.

**The bug:** `decodeTestFrame()` picks a file, then awaits
`api.decodeFrame(...)`; `imfDecodeTest()` picks a folder, then awaits
`api.imfOpen(...)` and `api.imfDecodeTestFrame(...)`;
`generateTestProxy()` picks a file, then awaits
`api.transcodeProxy(...)`. All three, on success, write their result
into the same `smartEngineDecodeResult`/`Label`/`Img` elements with no
coordination between them. Nothing stopped a user from clicking Decode
Test Frame, then clicking IMF Decode Test before the first call's
backend round trip resolved. Whichever call's `await` resolved *last*
won the shared panel, even if it started first and its answer is now
stale — e.g. a fast IMF decode result gets silently clobbered moments
later by a slow, now-superseded Decode Test Frame result finally
resolving, showing the user a decode outcome that doesn't match what
they just asked for.

**The fix:** added `let _decodeResultSeq = 0;` above `decodeTestFrame()`,
shared across all three functions since they all write the same
target. Each function now captures `const seq = ++_decodeResultSeq;`
immediately after its own picker resolves (right where it flips its
own button to a busy state), and guards every write to the shared
elements with `if (seq !== _decodeResultSeq) return;` — placed
immediately after each function's backend-call `await` resolves, and
again as the first line of each function's `catch` block. The one
exception is `generateTestProxy()`'s `catch`, which only shows a modal
via `friendlyAlert` and never touches the shared panel, so no guard was
needed there.

**Test:** `tests-js/smartEngineSettingsDecodeResultStaleRace.test.mjs`
(linkedom, since the module touches `document`/`window` at load time).
Mocks `window.pfxPlatform.smartMedia.decodeFrame` to return a promise
that only resolves when the test explicitly triggers it (identical in
spirit to Iterations 134/135's `pendingPing`/`pendingGetAll` pattern),
while `imfDecodeTestFrame` resolves immediately. Clicks Decode Test
Frame (suspends on the pending `decodeFrame()`), then clicks IMF
Decode Test (resolves immediately and writes "IMF · Engine:
imf-engine" to the panel), then resolves the older call's stale
"stale-engine" result and confirms the panel still shows the IMF
result and never displays the word "stale-engine" anywhere. 4
assertions total.

**Verification:** ran the test against the fix first — 4 of 4 passed.
Backed up the fixed file via `cp` to `/tmp/smart_engine_settings.js.bak`,
then temporarily stripped the three success-path
`if (seq !== _decodeResultSeq) return;` guards, and re-ran: 2 of 4
passed, with exactly the predicted assertions failing ("the stale,
superseded older decode result must not clobber the shared panel" and
"the stale decode result text must not appear in the panel at all") —
confirming the bug reproduces precisely as expected once the guards
are absent. Restored the exact fixed file via `cp` from the backup and
re-ran: 4 of 4 passed again; `git diff --stat` on the file after
restoring showed "19 insertions(+)", matching the pre-strip diff
exactly. This file had zero pre-existing WIP (per the clean-file
whitelist), so the fix was staged as a whole file with no `git add -p`
hunk-splitting required. Full `npm run test:js` regression is green
across every suite (0 failures anywhere in the run, including the
`selfContained.test.mjs` git-tracking gate once the new test file was
staged). `npm run test:node` also green, matching baseline (72 pass, 1
pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-135 — its pre-existing
WIP is too tightly interleaved (a fix-line hunk shares boundaries with
an unrelated `_updateFixButton()` feature) to isolate safely; do not
re-attempt until the developer's WIP in that file is committed or
shrinks.

Commits: `fa232ae`.

## Iteration 137 — VFX Pull Settings: a stale "Browse…" folder-picker result can clobber a freshly reloaded or reset settings object

**Why this file:** `src/scripts/features/vfxPull/vfxPullSettings.js`
was on the clean-file whitelist (no pre-existing uncommitted diff). A
first scouted candidate this iteration, `imf_proxy.js`'s `_httpToken`
race, was independently read in full and rejected: all its writers
write the same conceptual value (the companion's current session
token), and `_fetchWithTokenRefresh()` already retries once on 403 by
re-fetching a fresh token, so a stale write costs at most one extra
round trip — not a persistent wrong result. `vfxPullSettings.js` was
re-scouted and independently verified to meet the established bar: its
stale write sticks (persists to `localStorage`) and is visibly wrong
(wrong folder path shown and used for output) with no self-correction.

**The bug:** the Export tab's "Browse…" button
(`#pfxVfxStPickFolder`) sends an async `chrome.runtime.sendMessage`
IPC call to the native folder picker; its callback unconditionally
wrote the returned path into `_vs.settings.outputRootPath` and set
`_vs.dirty = true`. But `_vs.settings` itself is reassigned wholesale
in two places elsewhere in the same module: `_vsLoad()` (called from
`_vsOpen()` whenever the modal reopens with no unsaved edits) and the
Reset Defaults handler. Clicking Browse, then closing and reopening
the settings modal (or hitting Reset Defaults) before the native
picker resolved, meant the picker's callback still held a reference to
the *old* `_vs.settings` object conceptually but wrote through the
`_vs.settings` binding at call time — landing the stale folder choice
into whatever settings object the user was now looking at, silently
corrupting it. That corruption then persisted to `localStorage` on the
very next Save/Close, with no downstream validation to catch it.

**The fix:** added `var _vsSeq = 0;` alongside the `_vs` state object,
bumped once at the end of `_vsLoad()` and once in the Reset Defaults
click handler (the two places that reassign `_vs.settings` wholesale).
The Browse click handler now captures `var seqAtClick = _vsSeq;`
before firing the IPC call, and its callback's first line is
`if (seqAtClick !== _vsSeq) return;` — discarding the stale result
instead of writing it into a settings object the user has since
reloaded or reset.

**Test:** `tests-js/vfxPullSettingsBrowseStaleRace.test.mjs` (linkedom,
since the module touches `document`/`window`/`chrome.runtime` at wire
time and is a non-module IIFE script loaded via dynamic `import()` for
its side effects). Opens the settings modal via
`window._pfxVfxSettingsOpen()`, clicks the Export tab to render the
Browse… button, clicks it to suspend on a test-controlled
`chrome.runtime.sendMessage` callback, then closes and reopens the
modal (forcing `_vsLoad()` to swap in a fresh `_vs.settings`) before
resolving the stale picker callback with `/Volumes/Shared/STALE_PICK`.
Asserts the reloaded settings' `outputRootPath` is neither the stale
path nor mutated from its fresh default. 4 assertions total.

**Verification:** ran the test against the fix first — 4 of 4 passed.
Backed up the fixed file via `cp` to
`/tmp/vfxPullSettings.js.fixed`, then temporarily removed the
`if (seqAtClick !== _vsSeq) return;` guard line and re-ran: 2 of 4
passed, with exactly the predicted two assertions failing ("stale
Browse result must not be written into the reloaded settings object"
and "reloaded settings kept their fresh default output path") —
confirming the bug reproduces precisely as expected once the guard is
absent. Restored the exact fixed file via `cp` from the backup and
re-ran: 4 of 4 passed again. This file had zero pre-existing WIP (per
the clean-file whitelist), so the fix was staged as a whole file with
no `git add -p` hunk-splitting required. Full `npm run test:js`
regression is green across every suite (0 failures anywhere in the
run). `npm run test:node` also green, matching baseline (72 pass, 1
pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-136 — its pre-existing
WIP is too tightly interleaved (a fix-line hunk shares boundaries with
an unrelated `_updateFixButton()` feature) to isolate safely; do not
re-attempt until the developer's WIP in that file is committed or
shrinks.

Commits: `e709c73`.

## Iteration 138 — CutDiff2 video compare: silent-restore / auto-relink / manual-browse race can stomp a fresh pick with a stale one

**Why this file:** `src/scripts/features/cutdiff2/index.js`'s OLD/NEW
video-compare panel restores previously-linked proxy videos from
IndexedDB on multiple, independent, asynchronous code paths that can
all be in flight at once against the same on-screen filename/video
elements.

**The bug:** `applySnapshot()` fires an unawaited `_vcRestoreSilent()`
the moment a saved session is restored. If the user interacts with the
panel (e.g. clicks the legacy hidden browse button) before that
silent restore's `getFile()` resolves, a capture-phase auto-relink
listener (`_vcRestoreFromIDB()`) and the click's own handler
(`_vcBrowse()`) both start racing against the same stored file handle
— three concurrent chains reading and eventually writing to the same
`cd2x-vc-<which>-name`/video elements via `_vcLoad()`. Before the fix,
whichever chain's `getFile()` promise happened to settle *last*, won —
even if it was the stalest, oldest-intent request — silently
overwriting a video the user had just picked with a stale relink
result from a request they'd already superseded.

**The fix:** (pre-existing, already implemented prior to this
iteration, previously uncommitted) a `_vcLoadGen = { old: 0, new: 0 }`
generation counter. Each of `_vcBrowse()`, `_vcRestoreSilent()`, and
`_vcRestoreFromIDB()` synchronously claims
`const myGen = ++_vcLoadGen[which]` before its first `await`, then
checks `if (_vcLoadGen[which] > myGen) return/continue;` immediately
before calling `_vcLoad()` — so the highest-generation (most recent)
caller's write always wins, regardless of which `getFile()` promise
physically resolves first.

**Test:** `tests-js/cutdiff2VideoCompareLoadRace.test.mjs` (new,
linkedom, fixture `tests-js/fixtures/cd2_panel.html`). Mounts the
panel, calls `applySnapshot()` to start generation #1
(`_vcRestoreSilent`), then dispatches a single `click` on the hidden
`cd2x-vc-old-browse` button — whose capture-phase auto-relink listener
fires generation #2 (`_vcRestoreFromIDB`) before the button's own
bubble-phase handler fires generation #3 (`_vcBrowse`). A fake
IndexedDB backs one shared file handle whose `getFile()` is
manually resolved in *reverse* generation order (#3 first, #1 last),
proving the outcome is decided by generation, not resolution order.
Asserts all three `getFile()` calls are in flight, then that the
displayed filename ends up as the highest-generation result
(`browse-FRESH.mp4`) despite settling first. 2 assertions.

**Verification:** proved this is a genuine regression test, not a
tautology — backed up the source file, replaced all four
`_vcLoadGen[which] > myGen` guard conditions with `false`, re-ran the
test and confirmed it fails RED exactly as predicted (displayed name
becomes the oldest, stalest result, `silent-OLDEST.mp4`, instead of
the fresh pick). Restored the original file from the backup and
confirmed via `diff` it is byte-identical to the pre-mutation source,
then re-ran the test to confirm it passes GREEN again (2 of 2). Full
`npm run test:js` regression is green across every suite, including
the `selfContained.test.mjs` git-tracking gate once the two new files
were staged. `npm run test:node` matches baseline (72 pass, 1
pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-137 for the same reason
(pre-existing WIP too tightly interleaved to isolate safely).

Commits: `b842a31`.

## Iteration 139 — Reviews bin import: shared `importTarget` clobbered by a concurrent, unrelated picker

**Why this file:** `src/scripts/features/reviews/index.js`'s bin-import
flow (`__pfxOpenMediaPickerForBin`) falls back to a single shared
`fileInput` native `<input type="file">` element when the File System
Access API isn't available, stashing which bin ("shots" or "ref") the
dialog was opened for in a module-level `importTarget` variable that
is also written by the unrelated ref-video picker
(`__pfxOpenRefPicker`).

**The bug:** native OS file dialogs resolve asynchronously, on
arbitrary user think-time. If a user opened the Shots ("Add Clips")
dialog, then — before picking any files — also triggered the Ref
video picker (which writes `importTarget = 'ref'` when it opens its
own dialog), `importTarget` was left holding `'ref'`. When the user
went back and finished the original Shots dialog, `fileInput`'s
`'change'` handler read the now-stale `importTarget` and silently
added the picked files to the wrong bin, with a mislabeled status
toast to match.

**The fix:** added a dedicated `_fileInputTarget` variable that only
`__pfxOpenMediaPickerForBin` writes, captured at the moment `fileInput`
is opened. The `fileInput` `'change'` handler now reads
`_fileInputTarget` instead of the shared `importTarget` for both
`store.addClips(files, { bin: ... })` and the status label, so it can
no longer be clobbered by the independent ref-picker flow. 14-line
diff, fully isolated to this one closure.

**Test:** `tests-js/reviewsFileInputTargetStaleRace.test.mjs` (new).
Extracts the real `importTarget`/`_fileInputTarget` declarations,
`__pfxOpenMediaPickerForBin`, and the `fileInput` `'change'` handler
body out of the 10k-line monolithic module via source-slicing (mounting
the whole reviews tab isn't required to exercise this closure logic),
then builds a harness via `new Function(...)` with a fake
`EventTarget`-like `fileInput` and a fake `store.addClips` that records
`(files, bin)` calls. Simulates the race: opens the Shots picker
(forcing the native-dialog fallback path), clobbers the shared
`importTarget` to `'ref'` mid-flight (mirroring the unrelated ref
picker), then fires `fileInput`'s `'change'` event and asserts the
files land in `'shots'`, not `'ref'`.

**Verification:** confirmed the test fails RED without the fix (via
`git stash`/`git stash pop` on the isolated source change — the
untracked new test file survives a plain `git stash` since it only
stashes tracked modifications) and passes GREEN with it. Full `npm run
test:js` is green across every suite including the
`selfContained.test.mjs` git-tracking gate once the new test file was
staged. `npm run test:node` matches baseline (72 pass, 1 pre-existing
skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-138 for the same reason
(pre-existing WIP too tightly interleaved to isolate safely) — and is
now further compounded by a newer, unrelated 173-line setup-wizard/app-tour
WIP diff discovered this iteration, ruling the file out entirely for
any near-term iteration.

Commits: `f40d8bf`.

## Iteration 140 — Smart Playback Engine: companion URL/token cached forever, never picks up a restart or Settings change

**Why this file:** `src/scripts/modules/smart_playback_engine.js` is the
Chrome-extension-path client for the companion HTTP API, used by
`probe`, `decodeFrame`, `getEngineStatus`, `transcodeProxy`, `imfOpen`,
`imfDecodeTestFrame`, `resolveStatus`, and `showLogs`.

**The bug:** `_companionConfig()` memoized its `pfxStorage` read into a
module-level `_companionCfgCache` the first time any companion call
was made, and never invalidated it. The companion server mints a new
auth token on every restart, and a user can repoint the companion URL
from Settings — but once `_companionCfgCache` was populated, every
later call in this module kept sending the stale URL/token for the
rest of the page's lifetime. The sibling module
`smart_engine_settings.js` implements the identical helper *without*
caching (it re-reads `pfxStorage` on every call) for exactly this
reason, so its own "Check Engines" button correctly picked up a
change while this module's calls silently kept failing (401 /
connection-refused) against the old companion instance.

**The fix:** dropped the memoization — `_companionConfig()` now reads
`pfxStorage` fresh on every call, matching `smart_engine_settings.js`.
10-line diff, fully isolated to this one helper.

**Test:** `tests-js/smartPlaybackEngineCompanionConfigStale.test.mjs`
(new). Imports the real module directly (no DOM dependency), with a
mutable fake `pfxStorage.get()` and a `fetch` stub that records the
`X-PFX-Token` header and URL of each request. Calls `probe()` once,
then changes the stored `companionToken`/`companionUrl` and calls
`probe()` again, asserting the second request uses the updated
token/URL rather than the first call's cached values.

**Verification:** confirmed the test fails RED without the fix
(`git stash`/`git stash pop` on the isolated source change — got
`AssertionError: second call must use the updated token (got
"token-A")`) and passes GREEN with it. Full `npm run test:js` is green
across every suite including the `selfContained.test.mjs`
git-tracking gate once the new test file was staged. `npm run
test:node` matches baseline (72 pass, 1 pre-existing skip, 0 fail).

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-139 for the same reason
(pre-existing WIP too tightly interleaved to isolate safely).

Commits: `fbdf74a`.

## Iteration 141 — Project-bar Delete: the one dialog with no undo behind it was English-only, and buried its warning

**Scope of the audit:** the five paths staged for this iteration —
`src/scripts/core/confirmText.js` (new), `src/scripts/ui.js` (two
hunks), `src/scripts/modules/i18n.js` (18 dictionary rows),
`tests-js/confirmText.test.mjs` (new), `tests-js/errorI18n.test.mjs`
(scanner registration). No `dist/**` path, no packaged `.app`
content, and no binary was touched.

**The defect:** PostFlowX ships in seven languages and has localised
its *failures* since Iteration 27 — `core/friendlyError.js` routes
every message through `window.PFX_t`, and `errorI18n.test.mjs` fails
the build the moment a sentence would reach six locales in English.
None of that machinery was ever pointed at the *confirmations*. All
twenty-six `confirm()` calls in the renderer assembled an English
template inline. The most expensive of them deletes a folder off the
disk:

    Delete project "EP103"?

    This removes PFX/EP103/ from your Project Folder. This cannot be undone.

Two faults at once. It was English-only, so a reader in Bangkok or
Seoul was asked to parse the only warning they will ever get in a
second language. And the warning itself was packed into the tail of a
paragraph that opens with a path, so the two clauses that decide the
answer — everything inside it goes, and nothing brings it back — are
the last things read rather than the first. A misread failure message
costs a search; a misread delete costs the folder.

**The fix:** the wording moved into a pure leaf module,
`core/confirmText.js`, following the established testability pattern
(`vfxPull/idtBadge.js`, `electron/native/seekModel.js`). The three
sentences are now literals a scanner can find, each passed through the
same `translate()` shim; the project name and the `PFX/<name>/` path
are interpolated *around* them and are never translated, because a
localised copy of either names a different folder. The dialog now
reads:

    Delete this project?

    “EP103_VFX”
    PFX/EP103_VFX/

    This deletes the project folder and everything saved inside it.
    This cannot be undone — use Save As first if you might need a copy.

**Input validation.** The project name is user-typed and can be pasted
from anywhere, so `cleanName()` treats it as untrusted:

- *Line forgery.* There is no markup to escape in a `confirm()`, but
  there is layout — a name carrying `\n\nThis is safe.` would render
  as its own paragraph in the same voice as the sentences the app
  wrote. All whitespace runs are folded to a single space, so the name
  can never occupy a line of its own.
- *Warning displacement.* An 800-character name would scroll the two
  sentences that matter out of an alert box that does not scroll.
  Clamped to 80, with a trailing `…` so the reader can see it was
  clamped rather than conclude the name is wrong.
- *Surrogate splitting.* Caught during this audit and fixed before
  commit: the clamp originally sliced by UTF-16 code unit, so a name
  of emoji or astral CJK cut at unit 79 would end in a lone surrogate
  and render as `�`. Roughly half the audience for this dialog types
  in Thai, Japanese, Korean or Chinese, and a corrupt-looking name in
  the one dialog where the reader is checking they recognise the
  project is exactly the wrong place for it. The clamp now counts code
  points via `Array.from`.
- *Nullish input.* `null`/`undefined` are folded to the empty name
  rather than stringified, and an empty name drops the whole
  name-and-path block instead of rendering `“”` over `PFX//`. The
  three sentences are written to stand without it.

**Accepted trade-off, recorded deliberately.** For a name longer than
80 code points the displayed path contains the ellipsis and so is not
the literal path on disk. The alternative — rendering an 800-character
path — pushes the warning out of the dialog, which is the more
dangerous failure. The `…` is a visible truncation marker, so the
string is not silently false.

**No new attack surface.** `confirmText.js` performs no I/O, touches
no DOM, reads no storage, and constructs no HTML — its output goes to
a plain-text `confirm()`. It cannot contribute to the XSS gate (no
`innerHTML` sink), the XXE gate (no XML), or path traversal (it never
resolves or writes a path; the actual delete path is built downstream
in `ui.js` exactly as before, unchanged by this iteration).

**Error handling.** `translate()` already wraps its `window.PFX_t`
lookup in try/catch and falls back to the English literal, and
`i18n.js` installs `PFX_t` asynchronously. A delete pressed before the
dictionary settles, or a dictionary bug, therefore degrades to English
rather than throwing at the call site — covered by a dedicated test
that installs a throwing translator and asserts the dialog is still
usable.

**Liveness verified before any code was written.** The first candidate
for this fix was `_cdDeleteProject` in `features/cutdiff/index.js`,
which has an even barer `confirm(\`Delete project “${name}”?\`)`. It
was rejected: none of its seven project-bar element IDs
(`cutdiffProjectSelect`, `cutdiffProjectNew`, `cutdiffProjectRename`,
`cutdiffProjectDelete`, `cutdiffProjectSave`, `cutdiffProjectSaveAs`,
`cutdiffProjectLoad`) exists anywhere in `src/index.html`, so that is
dead UI and fixing it would have shipped nothing. The target actually
used is `#projDelete`, wired at `src/scripts/ui.js:14897` and present
at `src/index.html:530`.

**Test:** `tests-js/confirmText.test.mjs` (new), 12 tests. Covers the
assembly (consequence and irreversibility both stated; name and path
both survive; question before path before consequence, which is the
whole point of splitting the paragraph up), the untrusted-input
handling above, and the localisation contract (all three sentences
offered to `translate()` in order via `deepEqual`; name and path never
translated; a throwing translator still yields usable text). The last
test guards the specific way this kind of change rots — the new module
lands, the old template is left in place "for now", and the localised
text never reaches a user — by asserting `ui.js` imports and calls
`deleteProjectConfirm` and no longer contains
`This removes PFX/${name}/`. Dictionary coverage is deliberately *not*
duplicated here; `errorI18n.test.mjs` now scans `core/confirmText.js`
with `expected: 3`.

**Verification.** Two RED proofs beyond module-not-found, each
simulating a realistic regression rather than deleting the file:

1. Reverting *only* the `ui.js` call site to the old inline template
   → `✖ ui.js builds the delete dialog from this module` (11 pass, 1
   fail). The call-site guard bites.
2. Dropping *one* Thai dictionary row → `✖ th: every failure message
   is translated` and `✖ the six locales cover exactly the same keys`
   (`th key set differs from ko`). The i18n coverage guard bites.
3. Restoring the UTF-16 clamp → `✖ clamping a name never cuts a
   character in half`, reporting the trailing `\ud83c`.

Working tree confirmed byte-identical after every restore by shasum.
Full `npm run build-verify` exits 0 and holds the baseline: node 73
tests / 72 pass / 1 pre-existing skip / 0 fail, pytest 315 passed / 7
skipped, and all three gates clean (XSS, XXE, fail-open).

**Working-tree discipline.** `src/scripts/ui.js` carries two
pre-existing uncommitted hunks that are not mine — the `showError`
`pfxFriendlyText` wrapper and the Fun-box lazy-iframe lifecycle, both
part of the inherited 79-file delta. Rather than `git add` the file
and sweep them in, the index entry for `ui.js` was built explicitly
(`git hash-object` on HEAD-plus-my-two-hunks, then `git update-index
--cacheinfo`), so the commit contains only the import line and the
call site. Verified by reading back `git diff --cached -- ui.js`.

**Still open:** `_refreshStatus()` in `homeScreen.js` remains
unaddressed, carried over from Iterations 130-140 for the same reason
(pre-existing WIP too tightly interleaved to isolate safely). Newly
logged this iteration: `_cdDeleteProject` splices a project out of the
CutDiff index but never removes its stored snapshot at
`CD_PROJECT_KEY_PREFIX + id`, an orphaned-storage leak — dead UI
today, but a live bug the moment that panel is wired up.

Commits: `0de41fd`.

## Iteration 142 — Prep & Mark marker Delete: an information-free dialog that hid the fact the delete was reversible

**Scope.** The marker Delete button in the Prep & Mark slate inspector
(`#pmSlyMkDeleteBtn`). One confirmation string, its call site, six
dictionary locales, and the shared confirmation module introduced in
iteration 141.

**Defect.** The dialog read, in full:

    Delete "SH010"?

Two faults, and the second is the interesting one. The first is the same
gap iteration 141 closed for the project delete: the string was assembled
inline at the call site, so it reached all seven languages in English.

The second is the inverse of 141's problem. The project delete buried a
warning it genuinely needed. This delete needed no warning at all — it is
backed by a hundred-deep undo stack — and said nothing, which is worse
than it sounds. A bare "Delete X?" restates the button that was just
pressed and contributes no new fact, so the reader has to supply the
missing one themselves. The assumption a non-technical user makes about
a delete, working in a project full of other people's footage, is that
delete means gone. The dialog did nothing to correct that, so the
cautious answer was Cancel — and then a question to whoever is nearest.
That cost was paid on every marker delete, for an edit that was always
safe.

**Verification that the promise is true.** Copy that says "you can undo
this" is a liability if it is wrong, so the recoverability was confirmed
before it was written down, not after:

- `_pmSlySnapshot()` runs on the line immediately after the confirm and
  before the `splice`, and `_pmSlyRestoreSnapshot` refills
  `_pmClipMarkers` and `_pmMetaMap` wholesale. History is 100 deep.
- Annotations are not silently lost. `_pmSlySerializeState()` strips
  `thumb`, `thumbAnn`, `annoStrokes`, `_thumbCapturing` and
  `_thumbError`, which reads at first glance like undo discarding
  user-drawn work. It is not: annotation data lives in the separately
  persisted `_pmAnnotMap`, keyed by timecode rather than marker id, is
  not cleared on marker delete, and is reattached through the
  `mk.annoStrokes || annotEntry?.shapes` fallback via `_annotTcKey` /
  `recIn` — both preserved by the snapshot. The stripped fields are
  regenerable caches. A data-loss finding was drafted here and withdrawn.
- Undo is reachable three ways, not one: `#pmCtxUndoBtn`
  (`src/index.html:2276`), `#pmSlyUndoBtn` (`src/index.html:2811`), the
  Cmd/Ctrl-Z keydown handler at `prep_mark.js:24988`, and a voice command
  at `prep_mark.js:28928`.

**Fix.** `deleteMarkerConfirm(name)` added to `src/scripts/core/confirmText.js`
— the module was written generic in 141 for exactly this. The dialog now
carries the same three beats as the project delete with the last one
inverted: what is being deleted, what goes with it, and how to get it back.

    Delete this marker?

    “SH010_bg”

    This removes the marker and the note written on it.
    You can bring it back with Undo — Cmd+Z

**The shortcut is deliberately outside the translated sentence.** Three
reasons, in order of weight. It is platform-dependent: the same keydown
handler answers to `metaKey || ctrlKey`, so "Cmd+Z" is simply wrong on
the Windows and Linux extension builds. Baking it into the sentence
would need two dictionary keys per language for one idea. And a key-cap
label is not prose — it should no more be translated than the project
path in 141. It is rendered by `comboToDisplay('MOD+KeyZ')`, the function
the shortcuts UI already uses, so this dialog cannot drift from the rest
of the app's key hints.

`MOD+KeyZ` is the combo hard-coded in the Prep & Mark keydown handler,
**not** whatever the user may have remapped in the shortcuts editor —
that editor does not reach this handler. Rendering the configured combo
here would have looked more sophisticated and would have been a lie.

**Input validation.** The marker name comes from `sel.shotName || sel.id`,
and shot names are typed in spreadsheets and pasted in bulk, so the same
hardening the project name gets applies unchanged via the shared
`cleanName`: whitespace folded so a pasted newline cannot forge a line
that reads as the app talking, and an 80-code-point clamp so a long name
cannot push the undo line off the bottom of an alert that does not
scroll. The clamp counts code points, so a name of CJK or emoji is not
sliced mid-surrogate. Nullish input is handled as an empty name rather
than stringified into the dialog.

**Accuracy of the consequence line.** "the marker and the note written on
it" is exactly what the handler removes — it splices the marker (which
carries `note`, `noteType`, `scopeOfWork`, `shotName`), unregisters it,
and drops its `_pmLinkMap` entry. Drawn annotations survive, so the copy
does not claim they go. No folder path is shown, because a marker is not
a folder; repeating 141's `PFX/<name>/` line here would have pointed at
something that does not exist.

**No new attack surface.** A pure leaf module with two imports
(`translate`, `comboToDisplay`), no DOM access, no I/O, no storage. The
output goes to `confirm()`, which renders plain text.

**Error handling.** `translate()` is try/caught internally and falls back
to the English literal, so a delete pressed before `i18n.js` installs
`PFX_t` still yields a complete dialog. `comboToDisplay` reads
`navigator.platform` inside a try/catch and degrades to the Ctrl form.

**Test.** `tests-js/confirmText.test.mjs` grows from 12 tests to 20; the
`errorI18n.test.mjs` `SCANNED` count for `core/confirmText.js` goes 3 → 6.
The platform test pins `navigator.platform` in both directions rather
than reading the host's — the same test would otherwise assert `Cmd+Z`
on a developer Mac and `Ctrl+Z` on a Linux CI box and be green on both
while checking nothing.

**RED proofs.** Three realistic regressions, not deleted files:

1. Call site reverted to the old inline template → `✖ prep_mark.js builds
   the marker delete dialog from this module` (19 pass / 1 fail).
2. Shortcut hard-coded to `'Cmd+Z'` → `✖ the undo shortcut is correct for
   the platform the app is running on`, on the assertion
   `a Windows build was told to press Cmd`.
3. One Thai row dropped → `✖ th: every failure message is translated` and
   `✖ the six locales cover exactly the same keys`.

All three files restored from `/tmp` and verified byte-identical by shasum.

**Working-tree discipline.** `src/scripts/prep_mark.js` carries a
pre-existing uncommitted delta of +828/−136 that is not mine. Only my two
hunks were committed, by rebuilding the index entry from
`git show HEAD:src/scripts/prep_mark.js`, re-applying both edits under
`assert count == 1`, and `git update-index --cacheinfo` — the same
technique used for `ui.js` in 141, because interactive `git add -p` is
unavailable here. The staged diff was read back to confirm it is 4 added
lines and 1 removed line and nothing else.

**Gate.** `npm run build-verify` exit 0 — node 73 tests / 72 pass / 0 fail
/ 1 skipped, pytest 315 passed / 7 skipped, XSS / XXE / fail-open gates
clean.

**Still open.** Twenty-four `confirm()` sites remain inline and
English-only. The CutDiff orphaned-storage leak logged in 141 is
unchanged: `_cdDeleteProject` splices a project out of the index but
never removes its stored snapshot at `CD_PROJECT_KEY_PREFIX + id`.
`_refreshStatus()` in `homeScreen.js` remains untouched since iterations
130–140 — the pre-existing WIP around it is still too interleaved to
isolate safely.

Commits: `75f54e4`.

---

## Iteration 143 — the delete that was safe all along and said otherwise

**Defect.** IMF ▸ Proxy QC has a `🗑 Delete Proxy` button whose dialog
read:

    Delete proxy file?

    /Users/…/.cache/postflowx/proxies/imf/8f3caa21….mp4

    This cannot be undone.

Every word of that is true about the file and wrong about the
consequence. The proxy is a *cache entry*: the companion writes it into a
proxy root (`~/.cache/postflowx/proxies/` by default) and indexes it in a
content-addressable registry keyed on the CPL id, track-file ids, total
frames and edit rate, so pressing `▶ Generate` on the same package
rebuilds it. `proxy_registry.py` even ships `prune_registry()`. The
button's own tooltip knows this — it reads "Delete cached proxy file for
this CPL" — but a tooltip is not what anyone reads at the moment of
deciding.

So the app told an operator standing in front of a panel of studio master
material that a click was permanent when it was a cache eviction. The
predictable outcome is that nobody clicks it and multi-gigabyte
transcodes accumulate until a disk fills. This is iteration 142's defect
inverted: there the dialog withheld the good news, here it denied it.
Secondarily, the dialog was English-only like the rest, and printed
`(unknown path)` when it had no path — a line carrying no information,
placed where the reader is already under pressure.

**Fix.** `deleteProxyConfirm(path)` in `core/confirmText.js`, wired into
`imf_ui.js`'s `imfProxyDeleteBtn` handler. English output:

    Delete the proxy video?

    …/postflowx/proxies/imf/8f3caa21-proxy.mp4

    This only deletes the preview video PostFlowX made. The IMF package
    itself is not changed.
    You can make it again whenever you need it — ▶ Generate

Three new sentences × six locales = 18 dictionary rows.

**Verified before printed, not assumed.** "The IMF package itself is not
changed" is a promise about someone's studio masters, and the proxy root
is user-configurable — `setProxyRoot` (api.py:2087) means a proxy *can*
be written inside the folder holding the package. The reassurance
survives that only because `_delete_proxy` (api.py:903) builds its delete
list solely from a path whose suffix is `.mp4`, plus that same stem's
`.json`, `.progress` and `.log` siblings. IMF assets are `.mxf` and
`.xml`. The delete cannot reach them by construction rather than by
convention. Test 9 reads that function out of `api.py` and pins the
suffix guard, the sibling tuple, and the fact that there are exactly two
`paths_to_remove.append` calls, so relaxing the guard fails the build
rather than silently turning this sentence into a lie.

**`cleanPath` is not `cleanName`.** `cleanName` clamps from the right,
which is right for a project name. A path clamped from the right loses
the filename — the one token that says *which* file — and hands the
reader a directory they already knew. `cleanPath` keeps the tail and
prefixes `…`, clamped at 64 code points (`Array.from`, so a Thai or
Japanese path cannot be sliced mid-surrogate).

**Why the button name is in English.** The hint points at `▶ Generate`,
three buttons along. That label is not translated, and not by oversight:
i18n keys on whole strings, the dictionary has `"Generate"`, and the
button's text node is `▶ Generate`, which `_candKeys` (i18n.js) folds only
for whitespace and case — never for the glyph. So it reads English in
Thai and Korean too, and naming it in English is the accurate choice in
every locale rather than a shortcut. It is appended past an em dash as
its own token, the same bargain 142 struck with the Undo combo. A test
asserts `"▶ Generate":` is absent from the dictionary, so if anyone later
adds it the hint's claim is caught rather than quietly falsified.

**Test.** `tests-js/confirmText.test.mjs` grows 20 → 29; the
`errorI18n.test.mjs` `SCANNED` count for `core/confirmText.js` goes
6 → 9.

**RED proofs.** Four realistic regressions:

1. Call site reverted to the old inline template → `✖ imf_ui.js builds
   the proxy delete dialog from this module`.
2. `cleanPath` switched to clamp from the right → `✖ the proxy path keeps
   its filename when it is too long to show`.
3. One Thai row dropped → `✖ th: every failure message is translated`
   and `✖ the six locales cover exactly the same keys`.
4. `_delete_proxy`'s `.mp4` suffix guard loosened → `✖ the companion can
   only ever unlink an .mp4 — what the reassurance rests on`.

All four files restored from `/tmp` and verified byte-identical by
shasum (OK × 4).

**Working-tree discipline.** `src/scripts/modules/imf/imf_ui.js` carries
three pre-existing uncommitted hunks that are not mine — a
`pkg.fileMap instanceof Map` fix in `PLUGFEST_TESTS` (`Object.keys()` on a
Map returns `[]` and flags every MXF as missing) and an `AUD004` WARN
branch in `_labelResultsToValidation()`. Only my two hunks were
committed, by rebuilding the index entry from `git show HEAD:…`,
re-applying both edits under `assert count == 1`, and
`git update-index --cacheinfo` — the technique used for `ui.js` in 141 and
`prep_mark.js` in 142, because interactive `git add -p` is unavailable
here. The staged diff was read back: 4 added lines, 1 removed, nothing
else.

**Gate.** `npm run build-verify` exit 0 — node 73 tests / 72 pass / 0 fail
/ 1 skipped, pytest 315 passed / 7 skipped, XSS / XXE / fail-open gates
clean.

**Count correction.** Iteration 142 recorded twenty-four remaining
`confirm()` sites. That count missed `projectManager.js:436`, which uses
the `window.confirm(` form and slipped the survey's regex. The true
figure was twenty-six before 143 and is twenty-five after it.

**Still open.** Twenty-five `confirm()` sites remain inline and
English-only, including a class of seven "Reset X to defaults?" dialogs
that could share one helper. The CutDiff orphaned-storage leak logged in
141 is unchanged: `_cdDeleteProject` splices a project out of the index
but never removes its stored snapshot at `CD_PROJECT_KEY_PREFIX + id`.
`_refreshStatus()` in `homeScreen.js` remains untouched since iterations
130–140 — the pre-existing WIP around it is still too interleaved to
isolate safely.

Commits: `8600e79`.
