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
