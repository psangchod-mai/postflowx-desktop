# PostFlowX — Technical Strategy to Rival Clipster & Resolve

**Version reviewed:** PostFlowX 2026.6.1
**Date:** June 23, 2026
**Scope:** VFX pull, IMF validation + playback, automation for non-technical users
**Platform:** macOS only (Apple Silicon–first) — Windows is explicitly out of scope for this project

> **macOS-only implications (read first):** Targeting one platform removes the cross-platform burden and lets you lean on Apple's native media stack. Three consequences shape everything below: (1) you already ship a compiled **AVFoundation** bridge (`avf_bridge`), so ProRes/HEVC/H.264 playback and proxy can be hardware-decoded via **VideoToolbox** on Apple Silicon for free; (2) JPEG 2000 (the IMF codec) is **not** hardware-decodable on Mac and the NVIDIA GPU decoders (nvJPEG2000, CUDA Fastvideo) **do not exist on Apple Silicon** — J2K decode is CPU (OpenJPEG/Grok) or licensed Kakadu, full stop; (3) the renderer should be **Metal**-based (libplacebo via MoltenVK, or native Metal), and "zero-setup install" means a **signed + notarized** `.app`/`.pkg`.

---

## 1. Executive summary

PostFlowX today is a Chrome-extension UI backed by a Python "companion" service. The architecture is sound and deliberately hides media complexity behind one stable API — exactly the right shape for the three goals you set. The gap is not the design; it is that the hard engines are still stubs. Your own README confirms `startImfPlayback`, `runImfQc`, and the OCF→EXR export path are placeholders, while `scanImfPackage`, `buildProxy`, and `startProxyPlayback` work.

You cannot out-engineer Clipster or Resolve on raw playback by writing a JPEG 2000 decoder from scratch — both lean on the commercial Kakadu codec, and Resolve has a decade of GPU pipeline work behind it. The winning strategy is **not parity on everything**; it is to (1) match them on *correctness* (validation) using proven open-source engines, (2) reach *good-enough* frame-accurate IMF playback by integrating best-in-class libraries rather than building them, and (3) decisively *beat* them on automation and ease-of-use for non-technical operators, which is the one axis where Clipster and Resolve are genuinely weak.

The recommended path is to replace the stubs with a layered native engine: **asdcplib** (MXF/IMF essence) + **Photon** (validation) + **OpenJPEG/Grok or Kakadu** (J2K decode) + **libplacebo/mpv** (HDR/Dolby Vision rendering) for the player; **OpenTimelineIO** + camera RAW SDKs + **OpenEXR/OpenColorIO** for the VFX pull; and a watch-folder + preset + guided-recovery layer for automation.

---

## 2. Where PostFlowX is today (from the codebase)

| Capability | Status in code | Notes |
|---|---|---|
| IMF package scan | Working (`scanImfPackage`) | Parses package structure |
| Proxy build + playback | Working (`buildProxy`, `startProxyPlayback`) | Proxy path is the current playback story |
| IMF playback (native) | **Stub** (`startImfPlayback`) | Native helper protocol defined but engine not implemented |
| IMF QC | **Stub** (`runImfQc`) | No validation engine wired in |
| OCF → EXR VFX pull | **Stub** (`ocf_exr_handler.js`) | Handler contract documented; probing/export not implemented |
| AAF export | Present (`aaf_export.py`, bundles pyaaf2 1.7.1) | Foundation for conform/pull metadata |
| DaVinci Resolve bridge | Present (`resolve_bridge.py`) | `status` + `extractStillFrame` actions; uses Resolve scripting API |
| **AVFoundation bridge** | **Compiled binary present** (`avf_bridge`, 556 KB) | Native macOS media path — the foundation for hardware-accelerated ProRes/HEVC/H.264 decode via VideoToolbox; reuse it for proxy + non-J2K playback |
| Native helper protocol | Defined (`native-helper-protocol-v1.json`) | Timecode-accurate seek/step/thumbnail commands, event model, error codes — a good contract to build the real engine against |

**Key insight:** The native helper protocol is already well-specified (frame/timecode seek, step, thumbnail strip, playback events). You have the *interface*; you need the *engine* behind it. That de-risks the build considerably.

---

## 3. Competitive baseline

**R&S CLIPSTER** is a complete single-box IMF/DCP mastering and QC system: timeline conforming, IMF versioning/merging/supplemental packages, subtitle and closed-caption handling, audio channel mapping, built-in SMPTE compliance validation, Dolby Atmos, latest ST 2067-X delivery standards, and NexGuard forensic watermarking. It scales from a QC-playback-only tier up to full mastering. Its weakness: it is expensive, operator-trained, and not aimed at casual/non-technical users.

**DaVinci Resolve Studio** offers native IMF encode *and decode* using a **licensed Kakadu** JPEG 2000 implementation (full Part 1, much of Parts 2–3), GPU-accelerated Dolby Vision CMU, and Dolby Vision IMF export. Its weakness for your audience: it is a full color/edit suite — powerful but heavy, with a steep learning curve and no purpose-built "validate this IMF and tell me what's wrong in plain English" flow.

**The opening:** Neither tool is designed for a non-technical operator who just needs to *pull VFX*, *validate a master*, and *play it back to check it* without understanding MXF, CPLs, or color science. That is PostFlowX's lane.

---

## 4. Pillar 1 — IMF validation + playback

### 4.1 Validation (highest ROI, lowest risk — do this first)

Validation is where you can reach genuine Clipster-level *correctness* fastest, because the reference implementation is open source and made by Netflix.

- **Netflix Photon** (Java, Apache-2.0) is the de-facto open-source IMF validator implementing SMPTE ST 2067. It fully validates an IMP: parses CPL/PKL/ASSETMAP, performs deep asset inspection, Composition Playlist conformance and associativity checks, and supports modern plug-ins (IAB ST 2067-201, ISXD ST 2067-202, frame-based S-ADM ST 2067-203). Builds with JDK-11 via the bundled Gradle wrapper.
- **Integration approach:** Bundle a JRE and run Photon as a child process from the companion, OR call its `IMPValidator` REST-style interface. Map Photon's findings to a plain-language, color-coded report in the UI (pass / warning / fail with "what this means" and "how to fix"). This *is* your `runImfQc`.
- **Essence-level checks:** Pair Photon with **asdcplib** (C++, open source, maintained by CineCert; the same library lineage used across commercial D-cinema/IMF toolchains) to read MXF track files (JPEG 2000 / PCM / timed text), verify hashes against the PKL, confirm edit rates, and surface essence descriptors. asdcplib explicitly supports ST 2067-5 "IMF Essence Component" (AS-02).

**Result:** "Validation as powerful as Clipster" is achievable in a first release because you are integrating the industry reference validator, not inventing checks.

### 4.2 Playback engine

This is the harder problem. On macOS the work splits cleanly into two media paths — let Apple's stack handle what it can, and only hand-build the J2K path. Build it in layers behind the existing native-helper protocol:

1. **Non-J2K path (free, reuse what you have):** ProRes, HEVC, H.264, and your generated proxies should play through the existing **`avf_bridge`** → **AVFoundation / VideoToolbox**, which gives hardware-accelerated decode on Apple Silicon and accurate `AVPlayer`/`AVAssetReader` seeking. For most QC-by-proxy and proxy-playback flows you already have the engine; the job is wiring it to the native-helper protocol commands.
2. **Container/essence demux (J2K path):** `asdcplib` to extract J2K codestreams and PCM from the IMF MXF essence, frame-indexed for accurate seek.
3. **JPEG 2000 decode — the macOS constraint:** AVFoundation/VideoToolbox does **not** decode J2K, and there is **no GPU J2K decoder on Apple Silicon** (nvJPEG2000/CUDA/Fastvideo are NVIDIA-only). So the realistic options are:
   - **OpenJPEG** (BSD, free) — correct and portable, CPU-bound and slower (~4.2s/frame single-thread in published benchmarks vs Kakadu ~1.8s); parallelize across the many performance cores of Apple Silicon (M-series) to claw back real-time at lower res.
   - **Grok** (open source) — faster than OpenJPEG, fast sub-tile decode, lower memory; ~1/3 of Kakadu's speed.
   - **Kakadu** (commercial license) — what Resolve uses for J2K on every platform; the only realistic route to guaranteed real-time UHD J2K on Mac. A Metal-accelerated Kakadu path is the high-end option.
   - **Recommendation:** Ship **OpenJPEG/Grok (zero license)** as the default J2K engine, multithreaded for Apple Silicon, behind your decoder interface; offer **Kakadu** as an optional paid "performance engine." Do **not** plan around GPU J2K on Mac — it isn't available.
4. **HDR / Dolby Vision rendering (Metal):** Use **libplacebo** (the mpv rendering core, open source) running on **Metal via MoltenVK** — its Vulkan backend is supported on macOS through MoltenVK. It provides real-time dynamic HDR tone-mapping, Dolby Vision Profile 5 and 8.x reading/reshaping, and gamut mapping. Note: **DV Profile 7 (dual-layer) is not fully supported** by libplacebo — flag that as a known limitation vs Clipster/Resolve+Dolby license. Alternative: drive an EDR (Extended Dynamic Range) Metal layer directly for HDR10/PQ output on Pro Display XDR / compatible monitors.
5. **Frame accuracy & sync:** Drive everything off the timecode model already in your protocol (`seekTimecode`, `seekFrame`, `stepFrame`, `frameToTimecode`). Maintain an explicit frame index from asdcplib so J2K seeks are exact, not estimated; for the AVFoundation path, use `AVAssetReader` with `kCMTimeFlags` precise seeks.

**Honest positioning:** Real-time UHD *J2K* playback that matches Resolve on Mac requires Kakadu — there is no GPU shortcut on Apple Silicon. With OpenJPEG/Grok you get reliable frame-accurate *scrub/step/QC* playback plus real-time at lower res, which covers most validation/QC use cases. Anything that is ProRes/HEVC/H.264/proxy plays back hardware-accelerated and real-time today via `avf_bridge`. Set expectations on J2K accordingly in the roadmap.

---

## 5. Pillar 2 — VFX pull

The VFX pull is your most differentiated near-term win because the building blocks are mature and the workflow is well-defined.

### 5.1 Conform from editorial

- **OpenTimelineIO** (OTIO, Academy Software Foundation, open source) is the modern interchange layer. Use its adapters to read **CMX 3600 EDL**, **AAF** (from Avid Media Composer), and **FCP XML**. OTIO gives you a clean Python timeline object to compute pulls, apply handles, and track source TC. You already bundle pyaaf2, which complements OTIO for deep AAF metadata.
- **Handles:** Expand each clip's in/out by N frames (operator-set, with sensible defaults like 8/12/24) against source TC, clamped to available media — a standard pull requirement.

### 5.2 OCF decode → EXR

Implement the documented `ocf_exr_handler.js` contract using the right SDK per format:

| Camera format | SDK | License |
|---|---|---|
| ARRIRAW (.ari/.arx/.mxf) | ARRIRAW SDK / ARRI Reference Tool | Free; outputs OpenEXR in ACES, ships IDTs |
| RED (.r3d) | R3D SDK | Free SDK, formal license agreement; GPU (CUDA/OpenCL) accelerated decode |
| Blackmagic RAW (.braw) | Blackmagic RAW SDK | **Free, no fees**, Mac/Win/Linux, GPU + CPU decode |
| ProRes RAW / DPX / EXR seq | AVFoundation (ProRes RAW) / OpenImageIO | Native on macOS / open source |

All four camera SDKs (ARRIRAW, R3D, BRAW) ship macOS builds. On Apple Silicon, BRAW decodes via Metal/CPU; R3D GPU decode uses Metal/OpenCL (verify current R3D SDK Apple Silicon acceleration). ProRes RAW decodes natively through your existing AVFoundation path.

- **Output:** 16-bit float **OpenEXR**, converted to **ACES2065-1 (AP0)** scene-linear — the standard VFX interchange space. Use **OpenColorIO** with an ACES config so the IDT/transform is correct and consistent.
- **Naming & packaging:** Emit per-shot EXR sequences with frame-padded names, a pull manifest (shot, source reel, TC in/out, handles, color transform applied), and optional CDL/LUT sidecars — the deliverable VFX vendors actually expect.

### 5.3 Leverage the Resolve bridge

You already have `resolve_bridge.py` doing `extractStillFrame` via Resolve's scripting API. For shops that own Resolve, offer a "render pull through Resolve" engine (timeline import + render queue) as an alternative high-quality path — reusing the bridge pattern you've built rather than only relying on direct SDK decode.

---

## 6. Pillar 3 — Automation for non-technical users

This is the axis where you can clearly beat Clipster and Resolve. The reference patterns (Telestream CardAgent, EditShare FLOW, Creative Force) all win by removing decisions, not adding options.

1. **Watch folders + auto-detect.** Drop an IMF package or camera-card folder; PostFlowX recognizes the type (you already have `scanImfPackage` and the `ocfProbeFolder` contract), and proposes the obvious action ("Validate this IMF", "Pull VFX from this card") with one confirm button.
2. **Presets over parameters.** Ship named presets ("Netflix IMF QC", "ARRI ACES VFX pull, 8-frame handles", "ProRes proxy 1080p") so an operator picks an outcome, not codec flags. Make presets shareable JSON — facilities standardize once and everyone inherits.
3. **One-click jobs with honest progress.** You already have job status/log/progress endpoints. Surface them as a plain-language queue ("Pulling 42 shots… 12 done, ~6 min left"), not a console.
4. **Plain-language validation report.** Translate Photon/asdcplib findings into "✅ Master is valid" / "⚠️ 2 warnings (click to see)" / "❌ Audio channel count doesn't match CPL — here's how to fix it." This alone is a feature neither competitor offers cleanly.
5. **Guided error recovery.** Your envelope already carries `userMessage` and `retryable`. Use them: every failure should say what happened, whether to retry, and the one next step — never a stack trace.
6. **Zero-setup install.** The README's goal of hiding companion setup is critical. Bundle the JRE (Photon), decoders, and SDK runtimes inside the signed installer (`install_easy_macos.command` is the right instinct) so a non-technical user never touches a terminal, Python env, or codec download.

---

## 7. Architecture recommendations

- **Keep the engine-abstraction layer you scaffolded.** Define a `PlaybackEngine` and `DecodeEngine` interface; register AVFoundation (non-J2K) and OpenJPEG/Grok/Kakadu (J2K) behind it and report readiness via `getEngineInfo` / `getCapabilities`. This lets you ship free-by-default and upsell the Kakadu performance engine without UI changes.
- **Two playback engines, one protocol.** Route ProRes/HEVC/H.264/proxy to the existing `avf_bridge` (AVFoundation/VideoToolbox); route J2K/IMF essence to the `pfx-helper` (asdcplib + OpenJPEG). Both implement the same native-helper protocol so the UI never knows which engine is active.
- **Promote the native helper from stub to real process.** Implement the v1 protocol in a compiled `pfx-helper` binary (the `ocf_exr_handler.js` already references this CLI: `pfx-helper export-exr`, `ocf-probe`, `open-folder`). A single native binary that does demux + decode + EXR export keeps the Python companion as orchestrator and the heavy lifting in C++ (or Swift/Objective-C++ where it touches AVFoundation/Metal). Build it **arm64-native** (universal2 only if you still support Intel Macs).
- **Bundle, don't depend.** Every external engine (JRE/Photon, OpenJPEG, asdcplib, camera SDKs, libplacebo) ships inside the `.app` and is version-pinned. Non-technical users must never resolve a dependency. The whole bundle must be **code-signed with a Developer ID and notarized** by Apple — without notarization Gatekeeper will block a non-technical user's first launch, which would defeat the entire ease-of-use goal. Embedded executables and dylibs need the hardened runtime and correct entitlements.
- **Replace the legacy `tools/pfx_host.py`** with the companion path, as your README's next-steps note already plans. Drop the Windows manifest/installer artifacts (`manifests/windows`, `install_windows.ps1`) from the build to keep the project lean.

---

## 8. Phased roadmap

**Phase 1 — Validation that matches Clipster (≈ highest ROI).**
Wire Photon + asdcplib into `runImfQc`; ship the plain-language validation report and watch-folder auto-detect. This is a credible, defensible "as powerful as Clipster" claim on the validation axis with mostly integration work.

**Phase 2 — VFX pull, end to end.**
Implement `ocfProbeFolder` and `ocfExrExportStart` with BRAW (free) first, then ARRIRAW and R3D; OTIO conform from EDL/AAF; OpenEXR/ACES output via OpenColorIO; pull manifest + vendor packaging. Ship the "ARRI ACES pull" preset.

**Phase 3 — Native IMF playback.**
Build `pfx-helper` with asdcplib demux + OpenJPEG decode + libplacebo render against the existing protocol; frame-accurate scrub/step/thumbnail; HDR10 + DV P5/P8. Default free engine; Kakadu/GPU as optional performance plug-in.

**Phase 4 — Polish toward parity.**
Dolby Vision trim/QC depth, supplemental/versioned IMF packages, real-time UHD via GPU or Kakadu, forensic watermarking integration if facilities require it.

---

## 9. Build-vs-buy & licensing notes

| Component | Choice | License posture |
|---|---|---|
| IMF validation | Netflix Photon | Apache-2.0, free — ship it |
| MXF/IMF essence | asdcplib | Open source — ship it |
| J2K decode (default) | OpenJPEG / Grok (multithreaded for Apple Silicon) | BSD/open — free, slower |
| J2K decode (performance) | Kakadu | Commercial — optional paid engine (no GPU J2K on Apple Silicon) |
| Non-J2K playback | AVFoundation / VideoToolbox (via `avf_bridge`) | Native macOS — free, hardware-accelerated |
| HDR/DV render | libplacebo (Metal via MoltenVK) or native Metal EDR | Open source; DV P7 dual-layer unsupported |
| Conform | OpenTimelineIO + pyaaf2 | Open source — already partly bundled |
| Color | OpenColorIO + ACES config | Open source |
| Camera RAW | BRAW (free), ARRIRAW (free), R3D (free SDK, license agreement) | Verify each EULA permits redistribution in a signed app |

**Action item:** Before shipping, confirm redistribution rights for the R3D SDK and any Kakadu license tier, and Dolby Vision logo/trademark requirements if you advertise DV support.

---

## 10. Key risks

- **Real-time UHD J2K on Apple Silicon** has no GPU path — it underperforms Resolve unless you license Kakadu. This is a hard platform constraint, not a tuning issue; set expectations or budget for Kakadu.
- **Dolby Vision Profile 7** (dual-layer) is not covered by libplacebo; full DV parity needs a Dolby license path.
- **Apple notarization & signing** is now on the critical path: an unsigned/un-notarized bundle is blocked by Gatekeeper on first launch, which breaks the "zero-setup for non-technical users" promise. Budget for a Developer ID, hardened runtime, and the notarization step in CI.
- **Camera SDK redistribution** terms vary — legal review needed per SDK (macOS builds specifically).
- **Apple Silicon vs Intel:** decide whether to drop Intel. arm64-only simplifies engine builds and shrinks the bundle; universal2 doubles native-binary size and build/test matrix.
- **Bundling a JRE** for Photon adds installer size; acceptable given the "no setup" goal, but consider a native port long-term.
- **Scope creep toward "full Resolve"** — resist. Win on validation + pull + automation; reach parity on playback selectively.

---

## 11. Sources

- [Netflix Photon (GitHub)](https://github.com/Netflix/photon) · [Netflix TechBlog: Photon OSS](http://techblog.netflix.com/2016/06/netflix-and-imf-community.html) · [IMPValidator.java](https://github.com/Netflix/photon/blob/master/src/main/java/com/netflix/imflibrary/RESTfulInterfaces/IMPValidator.java)
- [SMPTE ST 2067 (Wikipedia)](https://en.wikipedia.org/wiki/SMPTE_ST_2067)
- [R&S CLIPSTER product page](https://www.rohde-schwarz.com/us/product/clp6-productstartpage_63493-229148.html) · [IMF mastering with CLIPSTER](https://www.rohde-schwarz.com/us/applications/imf-mastering-with-r-s-clipster-application-card_56279-580417.html) · [Televisual: Atmos/IMF update](https://www.televisual.com/news/rohde-schwarz-releases-dolby-atmos-and-imf-updates-for-clipster-mastering-system/)
- [DaVinci Resolve Studio](https://www.blackmagicdesign.com/products/davinciresolve/studio) · [Dolby Vision in Resolve (Dolby support)](https://professionalsupport.dolby.com/s/article/Quick-Start-Guide-Dolby-Vision-DaVinci-Resolve-Studio?language=en_US)
- [Fastvideo GPU JPEG2000 benchmarks](https://fastcompression.com/benchmarks/decoder-benchmarks-j2k.htm) · [NVIDIA nvJPEG2000](https://developer.nvidia.com/blog/accelerating-jpeg-2000-decoding-for-digital-pathology-and-satellite-images-using-the-nvjpeg2000-library/) · [Grok codec thread](https://encode.su/threads/2477-Grok-JPEG-2000-Codec)
- [asdcplib (CineCert, GitHub)](https://github.com/cinecert/asdcplib) · [CineCert open source](https://cinecert.com/opensource/)
- [libplacebo (GitHub)](https://github.com/haasn/libplacebo) · [Ultimate mpv.conf 2026 (DV/HDR)](https://carlosfelic.io/misc/best-mpv-config-2026/)
- [OpenTimelineIO (GitHub)](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) · [CMX3600 adapter](https://github.com/OpenTimelineIO/otio-cmx3600-adapter)
- [ARRIRAW FAQ / SDK](https://www.arri.com/en/learn-help/learn-help-camera-system/pre-postproduction/file-formats-data-handling/arriraw-faq) · [ACES pull to EXR workflow](https://sharktacos.github.io/OpenColorIO-configs/docs/PremierePull.html) · [ACESCentral conform↔VFX pipeline](https://community.acescentral.com/t/implementing-aces-pipeline-between-conform-vfx-colorgrading/3322)
- [Blackmagic RAW SDK (free)](https://www.blackmagicdesign.com/developer/products/braw/sdk-and-software) · [RED R3D SDK](https://www.reddigitalcinema.com/download/r3d-sdk) · [R3D SDK license](https://www.red.com/legal/red-r3d-sdk-license-agreement)
- [Telestream CardAgent / post ingest](https://www.telestream.net/solutions/post-production-ingest.htm) · [Creative Force workflow automation](https://www.creativeforce.io/challenges/manage-internal-external-post-production) · [EditShare FLOW](https://editshare.com/solutions/post-production/)
