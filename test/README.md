# PostFlowX timeline-parser test suite

Proves every NLE timeline parser produces a **contract-compliant, uniform**
event list that flows cleanly through the Pull Prep pipeline
(`computePullRange` → `validatePullList`).

## Run

```bash
npm run test:parsers      # parser contract + golden tests
npm run test:pipeline     # parsed events → pull range → validation (+ equivalence)
npm run test:node         # both of the above
npm test                  # test:node + test:js (tests-js/) + companion pytest
```

Uses Node's built-in runner (`node --test`) + `assert/strict`. No app build
needed. Node ≥ 20 (CI pins 20); auto-detects the parsers' ES-module `.js`.

> Node 22+ note: pass file **globs**, not a bare directory
> (`node --test test/parsers/*.test.mjs`), which the npm scripts already do.

## Layout

- `_setup.mjs` — installs the browser globals the renderer parsers expect
  (`DOMParser` via **linkedom**, `chrome.runtime.getURL`). Import it FIRST in
  every test. **Test-only — never imported by shipped code.**
- `_contract.mjs` — the single event contract (§1 of the task) + a `track`
  normalizer (OTIO emits `trackIndex`, EDL/AAF emit `track`) + fixture readers.
- `fixtures/` — small, hand-authored sample timelines (see matrix below).
- `parsers/` — one `*.test.mjs` per format: contract checks over every event +
  golden values specific to the fixture.
- `pipeline/` — whole-path tests (range/validate) + cross-format equivalence.

## Fixture matrix

| Fixture | Format | Exercises | Status |
|---|---|---|---|
| `simple_24.edl` | EDL | 3 cuts, FROM CLIP NAME, SOURCE FILE → reel, 24fps | ✅ |
| `dissolve_df.edl` | EDL | `D025` dissolve, drop-frame `;`, FCM DROP FRAME → 30 | ✅ |
| `resolve_basic.otio` | OTIO | 3 clips, media_reference, global_start record TC | ✅ |
| `resolve_retime.otio` | OTIO | LinearTimeWarp 2× (speedFactor 200) + reverse (−100) | ✅ |
| `resolve_compound.otio` | OTIO | nested Stack → single event (no crash/flatten) | ✅ |
| `fcpx_basic.fcpxml` | FCPXML | 2 clips, asset name → reel, 25fps | ✅ |
| `mixed_rate.fcpxml` | FCPXML | 24 + 30 clips normalized to sequence rate, correct seconds | ✅ |
| `premiere_basic.prproj` | PRPROJ | **gzip** XML, 2 clips, one disabled, tick→TC | ✅ |
| `ale_day.ale` | ALE | Heading/Column/Data, Tape → reel | ✅ |
| `avid_basic.aaf` | AAF | — | ⏭ **skipped — needs real sample** |

## Adding a fixture

1. Hand-author a **small** file under `fixtures/` (a few KB).
2. Probe the real parser output before writing assertions
   (`node --input-type=module -e "import './test/_setup.mjs'; …"`), then write a
   `parsers/<format>.test.mjs` that calls `assertParseResult(res, {sourceType})`
   for the contract + a few **golden** values (counts, first event's reel/TCs).
3. If a golden disagrees with real output, **fix the expectation, not the
   parser** — these parsers are field-tested. Note any quirk you hit.

### Known parser quirks (encoded in fixtures, not bugs to "fix")

- EDL `FCM: NON-DROP FRAME` matches the `/drop\s*frame/` rate guess and bumps
  fps to 30. `simple_24.edl` omits the FCM line to stay 24fps.
- EDL `* SOURCE FILE:` overrides `reel` with the file **stem** (not the col-2
  reel token).
- FCPXML uses the **asset `name`** as `reel` (not `metadataReel`).
- FCPXML normalizes mixed-rate clips to the **sequence** rate (source seconds
  stay correct).

## AAF — why it's skipped (and what's needed)

`aaf_worker.js` parses an **OLE2 (Structured Storage) binary**. Synthesizing
valid OLE2 bytes by hand risks a green test over a wrong fixture, which the task
forbids. To enable:

1. Commit a tiny **real** `.aaf` (exported from Avid/Resolve, no confidential
   content) as `fixtures/avid_basic.aaf`.
2. Refactor `src/scripts/modules/workers/aaf_worker.js` to `export` its pure
   functions (`parseOLE2`, `buildObjectTree`, `extractEvents`) while keeping the
   `self.onmessage` wrapper intact, then unskip `parsers/aaf.test.mjs` and
   assert `extractEvents(buildObjectTree(parseOLE2(buf)))` against the contract.

## `.drp` (DaVinci Resolve project)

`.drp` is a proprietary, version-specific ZIP/SQLite container with no stable
public schema. The router returns a typed `DRP_EXPORT_OTIO` hint guiding the
user to export OTIO/AAF/FCPXML/EDL (all parsed today) — see
`pipeline/router.test.mjs`. A native reader (Tier 2) would need a real sample
`.drp` and is intentionally not implemented blind.
