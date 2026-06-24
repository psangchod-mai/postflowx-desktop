# VFX Pull Mode — Manual QA Checklist

End-to-end acceptance pass covering the spec items shipped under the VFX Pull rebuild.
Run before any release that touches `scripts/features/vfxPull/`,
`scripts/smart/smartExr*.js`, or the companion's `_ocf_run_export` /
`_build_vf_chain` paths.

## 0 · Setup fixtures

Required on disk before the pass:

- An EDL / XML / FCPXML / OTIO timeline with **at least two VFX events**.
  - At least one event should have a constant speed change (e.g. 200%).
  - At least one event should have a reel name with a 3-digit episode token
    (e.g. `S01E03_…` or `…_103_…`) so episode-aware matching is exercised.
- A QT reference movie graded in **Rec709** that the timeline events
  reference.
- An **OCF folder** containing the camera originals the events should match
  against. Folder may contain noise files (.txt, .pdf) — they should be
  skipped by `SUPPORTED_SOURCE_EXTENSIONS`.

The companion process must be running. Verify by clicking **Test Connection**
in Project Setup → Resolve Engine (this no longer launches Resolve —
spec §5).

---

## 1 · Inputs load cleanly

- [ ] Load the EDL/XML/FCPXML/OTIO. Events appear in the project event list.
- [ ] Load the QT reference Rec709 master. `projectMeta.refVideoAssetId` is set
      (visible in DevTools: `window.PFX_RESOLVE_STATUS` shows nothing because
      Resolve auto-connect is decoupled — that's expected).
- [ ] Open **VFX Pull Mode** card. The 8-step workflow strip is visible:
      `Timeline › QT Ref › OCF › Reconnect › Color › Frame › EXR › QC`.
- [ ] Click **⚙ Settings**. The new widgets are present:
      Target resolution, QT ref colour disclosure, OCF working colour
      disclosure, Bake speed / Bake reframe checkboxes, Sidecar toggles,
      Export mode select, Browse + Open output folder buttons.

## 2 · OCF probe + reconnect

- [ ] Click **Analyze & Build VFX Pull Package**.
- [ ] When prompted for OCF folder, pick the fixture folder. The picker is the
      companion folder picker — files outside the OCF allowlist are dimmed
      (regression for spec §file-picker fixes).
- [ ] Progress bar advances past the OCF probe step. No `[object Object]` or
      `{folderPath: {…}}` errors in DevTools (regression for Bug 1).
- [ ] The shot row table renders. Each row shows:
  - **OCF / OCF? badge** — green when linked, red when missing.
  - **Confidence %** — non-zero, non-100% for partial matches.
  - **Episode token match** — shots whose reel contains `103` should
    auto-match the OCF named `…_103_…` with high confidence.
- [ ] Pick a known-good shot and click **Relink** in its row. The OCF picker
      opens with allowlist `mov, mp4, mxf, r3d, ari, arx, braw, dng, crm,
      tif, tiff, dpx, exr`. Selecting a different file produces a `MAN`
      badge on the row.

## 3 · Colour match (spec §8)

- [ ] Each row shows a `CDL N%` badge (colour confidence).
- [ ] Open DevTools and inspect `_state.jobs[0].color.match`. Expect the
      spec shape:
      `{ source:'qt_ref_rec709', workingSpace:'ACEScct',
         cdl:{slope, offset, power, sat, saturation},
         confidence, warnings, appliedToExr:false }`
- [ ] `appliedToExr` is **false** for every shot. The CDL is preview only.

## 4 · Frame match (spec §9)

- [ ] Each row shows a `FR N%` badge (frame-match confidence).
- [ ] Inspect `_state.jobs[0].reframe`. Expect:
      `{ mode:'match_qt_ref_uhd' | 'none',
         targetWidth:3840, targetHeight:2160,
         fit, scale, cropBox, notes,
         position, rotation, nleTransform,
         reference:{colorSpace:'Rec709', width, height, activeCrop},
         confidence, warnings }`.
- [ ] If the OCF has letterbox/pillarbox, `reframe.warnings` contains the
      detection note.

## 5 · Retime detection (spec §10a)

For a shot with **200% speed**:

- [ ] Row shows `SPD 200%` badge.
- [ ] Inspect `_state.jobs[i].retime`:
      `{ mode:'bake_to_timeline', hasSpeedChange:true, isDynamic:false,
         speed:2, speedPercent:200, reversed:false, freeze:null,
         speedKeys:[], sourceFrameMap:null, originalSummary:'200%' }`.
- [ ] `expectedRenderedFrameCount` ≈ `expectedFrameCount / 2`.

For a shot with a **dynamic speed ramp** (multiple `speedKeys`):

- [ ] Row shows `SPD DYN` badge.
- [ ] QC blocks (next step) include `DYNAMIC_RETIME_UNSUPPORTED` when
      Bake speed is on.

## 6 · QC report + block conditions (spec §12)

- [ ] Click **QC Report** → an HTML report opens.
- [ ] Each shot row in the report shows the spec's extended fields: OCF
      status/confidence, QT-ref TC, colour match CDL confidence, frame
      match confidence, speed (detected + baked), reframe baked,
      output resolution, expected vs actual frames, first/last frame,
      missing frames, warnings, `colorPipeline` (`'aces'` vs
      `'fallback_ffmpeg'`).
- [ ] **Block conditions appear in the report header.** With normal fixtures
      and no missing OCF, expect zero hard errors. Then deliberately:
  - [ ] Remove the QT reference → re-run. Expect `NO_QT_REFERENCE` error.
  - [ ] Remove the source folder pick → re-run. Expect `NO_OCF_FOLDER`.
  - [ ] Delete one source file → re-run. Expect `OCF_MISSING_PER_SHOT`.
  - [ ] Add a dynamic-ramp shot + Bake speed on → re-run. Expect
        `DYNAMIC_RETIME_UNSUPPORTED`.
  - [ ] Unset output folder + non-sidecar mode → expect `NO_OUTPUT_FOLDER`
        (warn level) in the report.

## 7 · EXR export (spec §5 + §10b)

Requires `_settings.outputFolder` set and `exportMode !== 'sidecar_only'`:

- [ ] Run analysis again. Progress shows `Exporting EXR…` in step 7.
- [ ] On completion, output folder contains:
      `<outputFolder>/03_exr/<plateName>/<plateName>.1001.exr` etc.
- [ ] Shot row shows `EXR ✓` badge when done, `EXR N%` mid-export,
      `EXR ✗` on failure.
- [ ] For a 200%-speed shot: the EXR sequence contains **half** the source
      frame range count.
- [ ] For a reframe-enabled shot with non-UHD source: the EXR sequence is
      `3840 × 2160`.
- [ ] For a shot with a dynamic ramp: export is **blocked** and a clean
      error appears (no half-rendered sequence on disk).

## 8 · Package layout (spec §11)

In `<outputFolder>/`:

- [ ] `00_reports/pull_report.csv`
- [ ] `00_reports/qc_report.html`
- [ ] `00_reports/qc_report.json` — schema `postflowx.vfxpull.qc.v2`
- [ ] `01_fdl/pull_list.fdl.csv`
- [ ] `01_fdl/<plateName>.fdl.json` for each shot
- [ ] `02_amf/<plateName>.amf` — contains valid XML, **not** `[object Object]`
      (regression for the AMF return-shape fix)
- [ ] `03_exr/<plateName>/<plateName>.NNNN.exr` for each shot when EXR
      export ran
- [ ] `05_nuke/nuke_handoff.py` — Python parses cleanly (`python3 -m py_compile
      <path>` exits 0).
- [ ] `05_nuke/<plateName>_frame_map.json` for each shot — `frame_map[]`,
      `nuke_retime`, `ae_time_remap` blocks; valid JSON; integer frame numbers.
- [ ] `05_ae/<plateName>.jsx` for each shot — After Effects handoff (run in AE
      to build the comp). Plate path points at `03_exr/<plateName>/`.
- [ ] `06_logs/export_log.json` — schema v2, populated `blocks`, `counts`,
      `shots`, `pkgLayout` (now includes `frameMap` + `ae`).

## 9 · AMF look transform mode behaviour (spec §8)

The AMF generator now uses three **canonical** modes — `ocf_native`,
`match_editorial`, `review_proxy`. The old names (`IDT_ONLY`,
`IDT_PLUS_MATCH_LOOK`, `DAILIES`, `RECEIPT`) are **deprecated aliases**
remapped via `LEGACY_MODE_MAP`; prefer the canonical names in new work.

For a shot with a populated `job.color.match.cdl`:

- [ ] **match_editorial** (alias `IDT_PLUS_MATCH_LOOK`) → AMF contains
      `<aces:lookTransform applied="false">` with the SOP+Sat CDL.
- [ ] **ocf_native** (alias `IDT_ONLY`) → AMF does **not** include the
      `<aces:lookTransform>` block.
- [ ] **review_proxy** (alias `DAILIES`) → AMF includes the lookTransform AND
      the Rec.709 `<aces:outputTransform>`.
- [ ] DEPRECATED: `RECEIPT` is remapped to `ocf_native` (IDT only) — it no
      longer emits a lookTransform or an `applied="true"` receipt block. If
      receipt-style "everything applied" metadata is needed, that's a separate
      feature request, not the current behaviour.

## 10 · Nuke handoff (spec §13)

Open `05_nuke/nuke_handoff.py` and verify:

- [ ] Each plate has a `Read` with `colorspace` set to `ACES - ACES2065-1`
      (or `ACES2065-1` fallback).
- [ ] Read label includes shot name, source OCF, TC range, speed, reframe
      mode, AMF + FDL filenames.
- [ ] When CDL was estimated: an `OCIOCDLTransform` node is emitted with
      `working_space="ACES - ACEScct"` and `disable=True` (preview only —
      spec rule: never bake the CDL into the plate).
- [ ] When `reframe.mode === 'none'` (EXR sequence wasn't UHD on disk):
      a `Reformat` node to `UHD_4K` is emitted.
- [ ] **Speed change is wired, not just labelled:**
  - [ ] A **dynamic ramp** shot (with a resolved `retime.sourceFrameMap`) emits a
        `TimeWarp` node whose `lookup` curve maps output→source plate-local
        frames (`tw["lookup"].setValueAt(...)`), and the label reads
        `DYNAMIC (frame map)` — not `DYNAMIC (review)`.
  - [ ] A **freeze** shot emits a `FrameHold` at the plate-local held frame.
- [ ] When the colour plan resolved `applyLook` with a show LUT: an
      `OCIOFileTransform` (show look / LMT) is emitted.
- [ ] A single shared `Viewer` at the bottom of the script with
      `viewerProcess` set to `Rec.709 (ACES)`.

## 11 · Resolve auto-connect compliance (cross-spec)

(Sanity — VFX Pull never trips the Resolve manual workflow.)

- [ ] Close Resolve completely.
- [ ] Run VFX Pull analysis. Resolve does **not** launch.
- [ ] EXR export proceeds via the ffmpeg fallback path. QC report shows
      `colorPipeline: 'fallback_ffmpeg'` and the
      "ffmpeg fallback decoder used — verify color accuracy" warning.

## 12 · Manual relink + project state persistence

- [ ] Pick a row, click **Relink**, choose an alternate OCF file.
- [ ] Reload the extension. The manually-linked path persists (via
      `_persistState`). The `MAN` badge re-appears on the row.

## 13 · Spec-compliance regression greps

Run from repo root before sign-off:

```bash
# Bug 1 — old payload shape
! grep -rn 'nativeProbeOcfFolder({' scripts || echo 'FAIL: Bug 1 regressed'

# Bug 2 — Browse must use nativePickFolder
grep -n 'nativeOpenOutputFolder' scripts/features/vfxPull/vfxPullPanel.js \
  | grep -v Open || echo 'FAIL: Bug 2 regressed'

# Bug 3 — planner must read handleFrames
! grep -n "handles: _settings.handles" scripts/features/vfxPull \
  || echo 'FAIL: Bug 3 regressed'

# Spec §6 — workflow strip must be the 8-step chain
grep -c 'pmVfxWfQc' scripts/features/vfxPull/vfxPullPanel.js
```

## 14 · Test suites

```bash
# Live JS suites (the canonical runners):
npm run test:node    # parser/pipeline/color — expect 0 fail
npm run test:js      # tests-js/* incl. nukeScript, nukeHandoff, aeScript, frameMap,
                     #   vfxPullCore, filters, edlExport, nukeImportScript, timelineModel — 0 fail
cd companion && python3 -m pytest tests/test_vfx_pull_exr.py -v   # expect 9 pass
cd postflowx-adobe && npm test   # adobe UXP cut-diff engine (tsx + node:test) — expect 13 pass
# Or run everything: `npm test` (chains test:node + test:js + companion pytest + adobe).
```

> NOTE: VFX-pull coverage lives under `tests-js/` (run by `npm run test:js`) —
> e.g. `vfxPullCore`, `nukeScript`, `nukeHandoff`, `aeScript`, `frameMap`,
> `cameraIdt`. The old `tests/js/vfx_pull.test.mjs` was orphaned by the `src/`
> reorg; its unique tests were ported into `tests-js/vfxPullCore.test.mjs` and
> the file removed. The remaining `tests/js/*` files are likewise pre-reorg and
> not wired into any runner — treat that whole directory as legacy.

---

## Sign-off

- Tester: ________________________
- Date: ________________________
- Build SHA: ________________________
- Spec version: PostFlowX VFX Pull Mode rebuild (spec items 1–15)

Any **FAIL** line must be addressed before release.
