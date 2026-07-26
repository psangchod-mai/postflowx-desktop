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
