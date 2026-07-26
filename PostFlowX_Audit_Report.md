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
