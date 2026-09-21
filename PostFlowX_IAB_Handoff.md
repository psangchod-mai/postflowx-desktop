# PostFlowX — IAB (Dolby Atmos) Immersive Decode & Display — Engineering Ticket

**Owner area:** IMF Validation → IAB tab · **Platform:** macOS (Apple Silicon)
**Date:** 2026-06-28 · **Priority:** High (user-requested)
**Goal:** IAB tab must populate PROFILE / BEDS / OBJECTS / GROUPS and render an immersive track view (bed + Object 1..N) like DaVinci Resolve.

---

## Problem
The IAB tab stays empty (PROFILE/BEDS/OBJECTS/GROUPS = "—") for Atmos/IAB IMF packages. Resolve shows the same content exploded into a 7.1.2 bed + N mono Object tracks. We need parity: at minimum the metadata + track view; ideally per-object audio.

## What we found (diagnosis — verified)
IAB carriage in IMF is the **Immersive Audio Bitstream (SMPTE ST 2098-2, mapped via ST 2067-201)** — a binary bitstream. There are **two package classes**, and the current code only handles part of one:

- **Class A — IAB with embedded S-ADM XML** (e.g. the Meridian test package). The current inspect path works *partway*.
- **Class B — pure IAB bitstream, no ADM XML** (e.g. BLR23 / SOSYALCLIM, whose A1 displays as "PCM"). The current path finds nothing.

### Verified evidence (Meridian fixture, sandbox run)
Ran the existing backward-scan extractor on the Meridian IAB MXF:
- ADM XML **was** extracted (105 KB). Element counts: `audioProgramme=1, audioContent=4, audioObject=49, audioPackFormat=49, audioTrackFormat=58`.
- **Object/content names came back empty.**

### Root cause #1 (the empty tab on ADM packages)
`_collect_named_nodes(root, "audioObject", "audioObjectName")` searches for `audioObjectName` as a **child element**, but EBU ADM stores the name as an **attribute** on `<audioObject>`. Result: `objectSummary.totalObjects = len(object_names) = 0` even though 49 objects exist → UI underpopulates. The true object count is already available via `admStats.audioObject` (=49) but the UI isn't driven from it.

### Root cause #2 (pure-bitstream packages)
`_inspect_iab_asset` → `_extract_embedded_adm_xml` only scans for `<ebuCoreMain>` / `<audioFormatExtended>` (S-ADM). A pure IAB essence has no ADM XML, so the scan returns nothing → empty tab, no fallback.

---

## Fix plan (three separable deliverables)

### FIX 1 — ADM attribute read + count-driven UI  *(quick win; unblocks Meridian-class)*
- In `companion/src/postflowx_companion/api.py`:
  - `_collect_named_nodes` (and `_inspect_iab_asset` @ ~6705): read names from **attributes** (`audioObjectName`, `audioContentName`, `audioPackFormatName`) with a child-element fallback; namespace-agnostic (`local-name()`).
  - Drive `objectSummary` from element counts (`admStats`), not just named lists. Derive bed vs object split: `audioPackFormat`/`typeLabel` = DirectSpeakers → bed; Objects → objects. Map bed layout (7.1.2 / 7.1.4 / 9.1.6) from the DirectSpeakers pack.
- **Acceptance:** loading the Meridian package and clicking Inspect shows OBJECTS=49 (and the bed), PROFILE/FRAME RATE/SAMPLE RATE filled.
- **Test:** `companion/tests/` golden test against the Meridian MXF asserting object count + bed layout.

### FIX 2 — ST 2098-2 IAB bitstream parser  *(pure-bitstream class)*
- New module (Python, stdlib): demux IAB frames from the MXF essence, parse IAFrame header (sampleRate / bitDepth / frameRate) + sub-elements — `BedDefinition` (channel layout + speaker labels), `ObjectDefinition` (count, gain, x/y/z, snap/zone), groups, bitstream profile/level. Feed the same fields `_inspect_iab_asset` returns.
- Carriage detection: classify IAB vs S-ADM vs MGA (ST 2127); route IAB→bitstream parser, S-ADM→XML path. (`imf_iab_labels.js` already has IAB/MGA labels.)
- Demux dependency: **asdcplib Dolby IAB fork** (`DolbyLaboratories-dolby/imf_iab_implementation`, AS-02) or ffmpeg where supported. Native → `# TODO(build-mac)`.
- **Acceptance:** a pure-IAB package (no ADM) populates the tab. **Needs a BLR23/SOSYALCLIM sample to validate.**

### FIX 3 — Resolve-style immersive track view + per-object audio
- Renderer (`src/scripts/modules/imf/imf_ui.js`, IAB tab): expand bed into speaker channels + list Object 1..N using the **existing** TYPE/#/NAME/LAYOUT/CH/GAIN/RENDER TARGET/QC columns; drive from FIX 1/2 metadata.
- Per-object/bed **audio** (play/explode with sound): Dolby IAB decoder/renderer or asdcplib Dolby fork; or reuse the existing `_find_iab_decoder_adapter` / `_run_iab_adapter_decode` / Resolve-engine path in `proxy_service.py`. Metadata view (FIX 1/3) does **not** require this. Native/licensed → `# TODO(build-mac)`.

---

## Key code references
- `companion/.../api.py`: `_inspect_immersive_audio` (758), `_start_iab_decode` (785), `_resolve_iab_asset` (4795), `_extract_embedded_adm_xml` (6591), `_inspect_iab_asset` (6705), `_collect_named_nodes`.
- `companion/.../proxy_service.py`: `_find_iab_decoder_adapter` (921), `_compute_immersive_audio_support` (1045), `_parse_cpl_iab_audio_segments` (1444), `start_iab_decode` (3225), `_decode_iab_worker` (3325).
- Renderer: `src/scripts/modules/imf/imf_ui.js`, `imf_iab_labels.js`, `imf_proxy.js` (`imfInspectImmersiveAudio`, `imfStartIabDecode`).

## Test fixtures
- **Class A (ADM-bearing, ready):** `/Users/psangchod/Movies/NMD/20230311_IMF Sample for Backlot New UI/3_audio supplemental/Meridian_tst_HD_23.976fps_HDRIAB_audio supplemental/IAB_c6faac8a-1ba5-4247-9db1-c79b251ac59f.mxf` — CPL declares `IABEssenceDescriptor` / ST 2067-201; tail has S-ADM (ebuCoreMain), 49 objects.
- **Class B (pure bitstream):** BLR23 / SOSYALCLIM package — **path TBD from Mai.**

## Constraints / notes
- IAB ≠ ADM XML ≠ MGA. Don't conflate the inspector's "ADM tree" label with the IAB bitstream path.
- Metadata + track display need **no Dolby license**; spatial/per-object audio render does.
- No GPU audio decode relevance; this is CPU/metadata + (optional) licensed decoder.
- Keep verification green: `npm run build-verify`. Add Python tests under `companion/tests/`.
