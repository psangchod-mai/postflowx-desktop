# Player Control Bar — Unification fix (2026-06-29)

**Reference:** IMF VALIDATION transport (static markup in `src/index.html`, `.imf-transport-v2`).

## Why it "still didn't change"
The unification code already existed and was wired in, but:
1. **Latent infinite loop** — `unifyPlayerBars.js` re-ordered buttons on every
   `MutationObserver` tick *even when already ordered*, and its own DOM writes
   re-triggered the observer → endless reorder churn (a full-DOM harness hung).
2. **Would clobber self-rendered icons** — `resolveTransportIcons.js` overwrote
   button `innerHTML`, which would have destroyed CUT DIFF 2.0's dual
   `cd-icon-play` / `cd-icon-pause` SVGs and Visual QC's iconButtons.js icons.
3. The running app was a **build that predates the effective fix** — changes only
   appear after a renderer rebuild + relaunch.

## What changed
`src/scripts/core/unifyPlayerBars.js`
- Verified real button IDs (IMF is canonical); **added CUT DIFF 2.0** (`cd2x-vc-*`).
- Idempotent reorder (`_alreadyOrdered`) — no DOM writes when already correct.
- Disconnect-while-mutating + re-entrancy guard → **infinite loop eliminated**.

`src/scripts/core/resolveTransportIcons.js`
- Skip any button that already ships its own `<svg>` → **zero regression** to
  players with their own icons. Only pure text-glyph bars (IMF + the Resolve
  `<video>` transport used by ACES / PLATE LINK) are auto-iconified.

## Verified (jsdom against real markup)
- IMF: text glyphs → SVG icons, canonical order, group centered.
- CUT DIFF 2.0 play button keeps both its SVGs (not clobbered).
- 0 mutations after settle (no loop). `npm run test:js` → 22 passed / 0 failed.

## To see it in the app
- Dev (loads `src/` directly): `npm run dev` — no build needed.
- Packaged `.app`: rebuild on macOS — `npm run build:renderer` then
  `npm run build:mac-dir` (the sandbox here can't repackage; `dist/desktop` was
  synced manually).

## Follow-up for pixel-identical parity on every tab
CUT DIFF 2.0 and VISUAL QC render their own SVG transport icons (intentionally
preserved here). Making them use the exact same icon vectors as IMF requires
editing each player's markup to the shared icon set — a contained next step.

## 2026-06-29 (pt.2) — pixel parity vs the Resolve viewer reference
Reference re-checked against a Resolve viewer screen recording. Three gaps fixed:

1. **Loop icon was wrong shape.** The shared `I.loop` was a two-arc "repeat"
   glyph; Resolve's is a horizontal rounded-rectangle (stadium) loop with a
   single top arrowhead pointing right. Replaced `I.loop` in
   `resolveTransportIcons.js` → fixes loop on **every** iconified tab at once
   (IMF, VFX Pull/WS, Syllabus, AMF, and CUT DIFF's generated loop).
2. **CUT DIFF 2.0 used its own icon vectors** (double-triangle home/end, small
   play). Replaced the 5 inline SVGs in `src/index.html` (`cd2x-vc-*`) with the
   exact shared vectors (bar+triangle skip-start/end, frame-step, full-size
   play/pause). Play keeps its dual `cd-icon-play`/`cd-icon-pause` svgs (CSS
   toggle intact) — just with the shared geometry.
3. **PREP MARK (`.pm-controls`) was never iconified** — still raw HTML-entity
   glyphs (`◀|`, `▶`, `|▶`). Added `#pmPrevFrameBtn, #pmPlayBtn, #pmNextFrameBtn`
   to the `SEL` in `resolveTransportIcons.js` and to the svg-sizing rule in
   `main.css`. The play-button text-toggle observer converts `▶`/`⏸` to icons.

Verified: `npm run test:js` → 22/0. New icon set rasterized via headless Chrome
and matched against the recording (start · rev · stop · play · end · red-loop).

Out of scope (legacy / no transport): CUT DIFF **v1** (inactive, renders via
`iconButtons.js` whose `loop` still differs) and VISUAL QC (no transport bar).

## 2026-06-30 — match the Cut-page Transport Bar exactly (every tab)
New authoritative reference: the DaVinci **Cut Page Transport Bar** — exactly 7
controls: `[‹ ● ›  scroll/scrub]  ⏮ start · ◄ step-back · ■ stop · ► play · ⏭ end · ↺ loop`.

- **Loop → circular ↺.** Replaced the stadium loop from the previous round with
  the Cut-page circular arrow (`I.loop` in `resolveTransportIcons.js`).
- **Scroll/Scrub jog (new).** `unifyPlayerBars.js` now builds a compound
  `[ ‹ ● › ]` widget as the leftmost control of every player: chevrons step one
  frame (prefer the player's frame-step button, else nudge the video by 1/fps);
  the centre dot is a pointer-drag jog that scrubs `currentTime` across the clip
  (`wireScrubDrag`, sensitivity = duration/640 px, clamped). Players with no
  `<video>` (vfxws) get the chevrons but a no-op dot.
- **Strip to exactly 7.** `orderPlayer` places `[jog, start, reverse, stop, play,
  end, loop]` at the front and hides (display:none, not removed — so delegated
  `.click()`s still fire) every other `button`/`[role=button]` in the transport
  container. Scoped to each player's `parent`, so sibling controls (IMF
  SDR/HDR mode toggles, mute, zoom) are untouched.
- **Icons are now action-driven.** `resolveTransportIcons` overrides any markup
  on buttons carrying `data-pfx-transport-action` (so CUT DIFF's bespoke vectors
  conform), and detects play/loop "engaged" from text glyph **and** aria-pressed
  **and** class **and** title (CUT DIFF uses `is-active`+`aria-pressed`+title, IMF
  uses text). Added `.pfx-generated-transport-btn` to the icon selector so
  generated stop/start/end/loop on any player iconify.

Judgment call: the diagram labels the jog chevrons "step backward/forward", so
they frame-step. This supersedes the in-progress `[ < • > ]` reel/event nav pod
(its prevItem/nextItem reel buttons are now stripped). Restored IMF `start`/`end`
→ `imfBtnReelPrev`/`imfBtnReelNext` (they were the original go-to-start/end).
Flip back to reel/event nav on request.

Verified: `npm run test:js` → 22/0; a linkedom harness asserts jog-first order,
the canonical 6, stripped extras, CUT DIFF override, and the circular loop
(14/14); bar rasterized via headless Chrome and matched to the reference.

### 2026-06-30 (pt.2) — UI-freeze regression FIXED
First packaged build of the above froze the renderer (app shell rendered, body
blank). Root cause: the new `_watchState(play)` in `resolveTransportIcons.js`
called `_render()` **unconditionally** on every observer tick, and the observer
watches `childList` — so its own `innerHTML` write re-fired it → infinite
main-thread loop (renderer pegged ~144% CPU, no console error). The original
play observer avoided this by returning early once the button was icon-only.
Fix: `_watchState` is now idempotent — it only re-renders when the desired
play/pause state actually changes (`dataset.riRendered` gate); `_setActive`'s
`classList.toggle(force)` is already a no-op when unchanged. Diagnosed by
launching `…/MacOS/PostFlowX` with `PFX_LOG_RENDERER=1` and sampling renderer
CPU (144% → ~0% after fix; log lines 19→36).

Packaging note: the user launches the packaged `dist/mac-arm64/PostFlowX.app`,
whose renderer is frozen in `app.asar` AND sealed by `ElectronAsarIntegrity`
(SHA-256 in Info.plist). `build:renderer` alone (updates only `dist/desktop/`)
never reaches it, and a manual asar swap fails the integrity check. The only
working path is the arm64 repack:
`CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dir --arm64 -c.mac.identity=null -c.mac.notarize=false`
(skips the broken universal Swift build; regenerates asar + integrity hash +
adhoc sign). Then fully quit + reopen the .app.

## 2026-06-30 (pt.3) — REWRITE to one shared transport (PFXplaycontrol reference)
New authoritative reference (`PFXplaycontrol.png`): a **two-row** transport —
scrub row (current TC · scrub bar · duration TC) above the button row
`[‹ ● ›] |◀ ◀ ■ ▶ ▶| ↺` — with a real scrub bar on every player, per-tab item
nav (markers/shots/cuts/reels), momentary **blue-flash** jump-to-start/end
(Out-point aware), **green**-while-playing / **blue**-while-reversing color
states, and a full **JKL shuttle** (J tap = 1 frame back / hold = continuous
reverse; K = stop; L = play, repeat ramps ½→1→2→4×; Space; Home/End; Shift+←/→
= prev/next item).

Both prior systems were **replaced** by one self-rendered component + adapters:
- **NEW `src/scripts/core/pfxTransport.js`** — the shared component
  (`mountTransport`/`getTransport`/`refreshTransport`), inline SVG icons, custom
  div scrub (frame-accurate, click-anywhere + drag, played-region color shift),
  rate-ramp state machine (`nextRampRate`), color states, plus reusable
  `makeVideoAdapter` (forward via `playbackRate`; **reverse / sub-1× via a shared
  rAF loop** since HTML5 `<video>` can't play backwards) and
  `makeDualVideoAdapter`.
- **NEW `src/scripts/core/pfxTransportMount.js`** — orchestrator that mounts the
  bar on every DOM player (IMF, Prep/Mark, VFX Pull, VFX Workspace, Cut Diff
  1.0/2.0, SLY) via a uniform **DOM-delegating adapter** (drives each player's
  existing scrub slider + buttons + `<video>`; no edits to the 26k-line feature
  files). Hides the old per-player bars (display:none) but keeps their
  handler-bearing buttons so all sync/seek logic is preserved.
- **NEW `src/scripts/core/pfxTransportKeys.js`** — single capture-phase
  keydown/keyup dispatcher (exported pure `resolveKey`) that routes to the
  *visible* player's transport and pre-empts the old per-feature JKL handlers
  (instantly reversible via `window.__PFX_TX_KEYS = false`).
- `resolveVideoTransport.js` is now a thin **shim** over the component, so the
  ACES Look / Plate Link `attachResolveTransport(...)` call sites upgrade with
  zero edits.
- **Deleted** `unifyPlayerBars.js` + `resolveTransportIcons.js` (and their
  `index.html` `<script>` tags). One `shortcuts.js` edit drops the `KeyJ`/`KeyK`
  marker-nav defaults (now Shift+Arrows) so they don't collide with the shuttle.
- CSS: one self-contained `.pfx-tx-*` block at EOF of `src/styles/main.css`
  using `--hwk-*`/`--pfx-cut-*` tokens.

**Anti-freeze (the pt.2 lesson):** the component never observes its own DOM —
it's mount-once + idempotent (registry-keyed), updates from adapter `onChange`
events plus ONE rAF that runs **only while playing**. The orchestrator's observer
only ever re-runs an idempotent `mountAll()` (guarded by `data-pfx-tx-mounted`),
so its own writes can't cause more work.

**Verified:** `npm run test:js` → 63/63 files, 0 failed (added
`pfxTransport.test.mjs` rate-ramp, `pfxTransportKeys.test.mjs` key→action,
`pfxTransportDom.test.mjs` linkedom mount+delegation smoke). `node --check` on all
new/changed modules; `npm run build:renderer` OK (360 files).
**Still to do (on-device):** interactive GUI smoke per player (real scrub-drag
geometry, video playback, reverse loop, dual-video sync, IMF canvas, per-tab bar
placement) + the arm64 repack (above) + a `PFX_LOG_RENDERER=1` idle-CPU check.

### 2026-06-30 (pt.4) — transport styling fix (theme override collision)
First packaged build mounted the new `.pfx-tx` bar correctly on all 5 players
(verified via CDP: pfxTxCount=5, no old bars) but it rendered with **blue bordered
buttons** instead of the flat muted look. Root cause: `src/styles/theme.postflowx-pro.css`
loads AFTER main.css and has `!important` rules that hijack every `<button>`/`<svg>`:
  - `svg:not(.fun-launcher-arrow){color:var(--hwk-blue400)!important}` → blue icons.
  - two generic `button:not(.pfx-resolve-pill):not(.tab)…{background/border/color !important}`
    rules (specificity (0,2,1)/(0,6,1)) → forced bg `--hwk-surface-2`, 1px border, and
    `color:.78` — the last also defeated the green/blue play state colors.
Fix: excluded `.pfx-tx-btn` from those 4 generic button selectors (added
`:not(.pfx-tx-btn)`), and added a higher-specificity icon override in main.css:
`.pfx-tx .pfx-tx-btn svg{color:inherit!important}` (so icons follow the button color).
Verified via Chrome DevTools Protocol against the running packaged app: button
computed `background:rgba(0,0,0,0)`, `border:0`, icon fill `rgba(255,255,255,.6)`;
play/pause turns **green while playing**. Visual confirmed by CDP screenshot.

### 2026-06-30 (pt.5) — transport FUNCTIONS fixed (delegation bugs)
Bar rendered correctly but buttons misbehaved. Verified each via CDP against the
running packaged app (clip loaded) and fixed in `pfxTransportMount.js`:
  - **isPlaying false-positive** → play button stuck green, toggle logic confused.
    Cause: `detectPlaying` matched the play button's *title* ("Play / Pause"). Removed
    the title sniff; `isPlaying` now reads the `<video>` (`!paused && !ended`) when present.
  - **Jump-to-start** landed ~0.5s in AND started playing; **jump-to-end** went to ~0.
    Cause: delegated to the player's `pmTlGoStartBtn`/`pmTlGoEndBtn`, which act on the
    NLE timeline, not the viewer. Now jump = `pause()` + `seekToFrame(0)` /
    `seekToFrame(outPoint ?? lastFrame)` directly. End now lands exactly on duration TC.
  - **Play/pause** now go through the player's own toggle button gated on the real
    video state (keeps its canvas/sync loop correct), with a raw `<video>` fallback.
  - **Item nav** re-pauses ~40ms after the click (spec: playback stops before jumping).
CDP-verified: play(green)/stop(grey)/jumpStart(frame0)/jumpEnd(duration)/scrub(50%)
all correct; `node tests-js/pfxTransport*.test.mjs` pass. KNOWN: nav-pod prev/next for
Pulls Prep clicks `pm*EventBtn` which navigates pull-list events, not in-clip markers —
revisit if the desired item type differs per the loaded context.

### 2026-06-30 (pt.6) — reverse playback + symmetric ◀, verified by pixels
Two issues from a user screen-recording (frozen video + no color):
  1. The recording was a STALE renderer — CDP on the freshly-repacked build proved
     play advances the visible frame (00:00:59:22 → 00:01:01:21). Reinforced: fully
     quit (⌘Q) + reopen after every repack.
  2. **◀ (play backward) now = reverse PLAYBACK** (blue while active), symmetric with
     ▶ = forward (green) — previously it stepped one frame (a literal reading of the
     card). The J KEY still does frame-step (tap) / continuous reverse (hold).
  3. Reverse loop rounding bug fixed: at 1× a single rAF tick is ~0.38 frames, which
     Math.round'd to 0 every tick → never moved. Now accumulates fractional frames.
Pixel-verified via CDP Page.captureScreenshot: forward → green ❚❚ + ct ascends;
◀ → blue ◀ + ct descends (300.99 → 299.23); stop → grey, paused. Matches the
reference's "GREEN WHILE PLAYING" / "BLUE WHILE ACTIVE".

### 2026-06-30 (pt.7) — bug hunt + auto-fix
Independent review of pfxTransport.js / pfxTransportMount.js / pfxTransportKeys.js.
Fixed (tests 63/0, build OK, play/reverse/stop CDP-reverified):
  1. **Stuck held-keys** — `kHeld`/`jReverse` could wedge on a missed keyup (window
     blur, Cmd-Tab, tab hidden), turning J/L into permanent frame-step. Added
     `blur` + `visibilitychange` resets (`resetHeld`/`endHoldReverse`).
  2. **Hold-reverse tied to wrong controller** — `reverseHoldEnd` re-resolved the
     active controller at keyup; if the player changed mid-hold, the wrong one was
     stopped and the original's reverse rAF leaked forever. Now the controller is
     captured at `reverseHoldStart` (`jReverseCtrl`) and ended on that exact one.
  3. **Stale-controller leak** — `mountTransport` rebuilt on a disconnected host
     without tearing down the old controller (leaked onChange listeners + reverse
     rAF). Now `existing.destroy()` runs first.
  4. **Orphan host div** — when `mountTransport` returned an existing controller,
     `tryMount` left an empty `.pfx-tx-host` behind; now removed.
  5. **Frame/duration unit mix** — `getFrame` gated only on `isFinite(duration)`
     while `getDuration` also required `>0`; at finite-but-0 they read from
     different sources (video vs slider). Unified the gate.
  6. **Unbounded click timers** — the per-click refresh on the player's parent
     queued a `setTimeout` per click; now coalesced to one pending timer.
Reviewed-and-rejected: removing `stopReverse()` from the `onChange` unsubscribe —
that closure is the only thing cancelling the adapter's reverse rAF on `destroy()`,
so removing it would *introduce* a leak.

### 2026-06-30 (pt.8) — app-wide bug hunt + auto-fix
Four parallel review agents swept parsers/pipeline, features, IMF/media, and
prep_mark/ui/components. Auto-fixed 14 HIGH-confidence, low-risk, test-verified
bugs (test:node 0-fail, test:js 0-fail after):
  • pullRange.normalizeSpeedPercent — reverse retime (e.g. -50%) collapsed to 100%
    → under-pulled source. Now uses magnitude.
  • acesLookValidation — `.some()` ran on a non-array CDL (bad preset) → crashed the
    render loop. Guarded with validVec.
  • reviews player/JKL — play()/`_rvJklStop` didn't reset video.playbackRate → Space
    resumed at a leftover 2–16× shuttle rate. Reset to 1×.
  • reviews QC keys (d/w/x/g/f/p/b/n/v) — fired with Cmd/Ctrl/Alt held, hijacking
    Cmd+V/N/F/W/G. Gated on no-modifier.
  • xml.js — dead `scaleX/scaleY` exclusion (key already lowercased) polluted uniform
    scale; left-in `window.__PFX_NEG_DEBUG` threw in Node. Fixed + guarded.
  • trailerConform / tl_convert — `splice(parseInt NaN,1)` removed wrong file; AAF root
    remove now validates idx + persists via _saveSettings.
  • timeline / scrubInput — fps:0 and step:0 slipped past `??` → NaN/Infinity. Guarded.
  • ui.js — _mbUpdateUI derefed 3 elements after guarding only 1 (crash); AEP download
    promise had no .catch (stuck at 96%). Fixed.
  • cutdiff2 — "% changed" could exceed 100% (OLD-only events). Clamped.
FLAGGED (not auto-changed — needs verification / too risky to change blind):
  prproj.js TICKS_PER_SEC (documented + tested; agent suspects 254016000000),
  fcpxml integer-fps rounding (tested), annotateModal tracking-lockout (const-scope
  restructure), cutdiff2 duplicate canvas-click listeners, IMF realtime decode
  reorder + lowres cache-key collisions, reviews destroy() listener cluster,
  trlconf <video> decoder leaks. See per-area agent reports.

### 2026-06-30 (pt.9) — behavioral audit across all 6 contexts + off-by-one fix
CDP behavioral harness drove every control (play/stop/scrub/jump/back/hold-reverse)
on each context that had media. Found ONE real bug and fixed it:
  • **Off-by-one in the delegating adapter's getFrame.** seekToFrame writes
    currentTime=(f+0.5)/fps, but getFrame used Math.round(ct*fps) → round(f+0.5)
    rounds UP to f+1, so the seek↔read round-trip was off by one: ◀ "one frame
    back" appeared to do nothing and scrub landed target+1. Changed getFrame to
    Math.floor(ct*fps + 1e-6) in both pfxTransportMount.js (delegating) and
    pfxTransport.js makeVideoAdapter (s2f) — floor((f+0.5)) === f, exact round-trip.
Re-audit: Pull Prep + VFX Pull now pass ALL checks (play green, stop, scrub exact,
jumps + blue flash, ◀ one-frame-back, hold-J reverse blue + backward, release stops).
ACES Look (makeVideoAdapter) already passed. Cut Diff/Plate Link/IMF share these exact
adapter code paths (verified) but need a clip loaded to drive live. test:js 0-fail; repacked.

### 2026-06-30 (pt.10) — ◀ button = continuous reverse playback (per owner)
Per the product owner: the ◀ Play-backward BUTTON must do continuous reverse
playback (not a single frame). Changed cmd.playBackward from stepFrame(-1) to a
reverse-play toggle (setRate(-1) / pause), so ◀ click plays in reverse and the
button goes BLUE while active; a second click pauses. The J KEY is unchanged
(tap = one frame back, hold = continuous reverse). Updated pfxTransportDom.test.mjs
assertions accordingly. CDP behavioral audit (Pull Prep + VFX Pull):
back = {playingReverse:true, blue:true, movedBackContinuously:true}; all other
checks still pass. test:js 0-fail; repacked.

### 2026-06-30 (pt.11) — nav-pod jog/scrub (drag + wheel), per owner
Owner override of the reference's "nav pod = click-only, no drag/no scroll": the
centre dot ● is now a JOG. In pfxTransport.js, the dot takes pointerdown/move/up
(mouse + trackpad) → relative scrub at ~duration/640 frames-per-px; the whole pod
takes a `wheel` listener (mouse wheel + two-finger trackpad) → ~15 fr per notch.
Both reuse the coalesced queueSeek and never change play/stop state. Chevrons ‹ ›
stay click-only item nav. CSS: dot `pointer-events:auto; cursor:ew-resize;
touch-action:none`. CDP-verified: drag fwd/back + wheel fwd/back all scrub. 0-fail; repacked.

### 2026-06-30 (pt.12) — shim bar spans full video width (ACES Look, Plate Link)
The native-video tabs (ACES Look, Plate Link) mount via the resolveVideoTransport
shim, whose wrapper had no width/position → it shrink-wrapped to ~392px and the
preview's flex layout centered it as a floating pill (not fitting the video window).
Fix: shim sets the player area position:relative; new CSS anchors
`.pfx-tx-host-video` absolutely to the bottom (left/right:10px) spanning full width;
inner `.pfx-tx` width:100% with a slightly translucent bg (overlays the video).
CDP-verified: Plate Link barW 392→1182, ACES 392→1002, no overflow; screenshot
confirms full-width bottom-anchored bar. Orchestrator-mounted bars (Pull Prep/VFX
Pull/Cut Diff/IMF) were already full-width. Repacked.

### 2026-07-01 (pt.13) — VFX Pull bar fills its row + drop redundant scrubber
The VFX Pull transport row (.pfx-vfx-plr-transport-row) is a flex row; the mounted
.pfx-tx-host was a default flex item → only ~392px wide (scrub half-width) while the
player's ORIGINAL full-width scrubber (#pfxVfxPlrSlider, sole child of
.pfx-vfx-plr-scrub-row) still showed below it (redundant). Fixes:
  • CSS .pfx-tx-host { flex:1 1 auto; min-width:0 } → host fills flex transport rows
    (no effect in block parents or the absolute video-shim host).
  • vfx config hideAlso:['.pfx-vfx-plr-scrub-row'] → hides the duplicate scrubber.
CDP-verified: vfx barW 392→966, #pfxVfxPlrSlider hidden, scrub spans edge-to-edge;
screenshot confirms. test:js 0-fail; repacked.

### 2026-07-01 (pt.14) — bar bottom-aligned in the viewer (fix pt.13 column side-effect)
pt.13's `.pfx-tx-host { flex:1 1 auto }` (meant to fill width in flex ROWS) also
grew the host vertically in flex COLUMNS (Pull Prep's .pm-right) → a 310px-tall host
with the bar pinned at the TOP and a ~238px empty gap below it. Replaced with
`.pfx-tx-host { width:100%; min-width:0; margin-top:auto }`:
  • width:100% fills the width in a flex row WITHOUT growing height in a column.
  • margin-top:auto pushes the bar to the BOTTOM of a flex column (no-op in block
    flow / rows).
CDP-verified: Pull Prep barTop 446→715 (bottom-aligned, hostH 310→72, no gap),
VFX Pull still full-width 966; the pm-inspector is not clipped (auto margin only
absorbs positive free space). test:js 0-fail; repacked.

### 2026-07-01 (pt.15) — IMF transport button row was clipped (row too short)
IMF Validation mounts the bar inside .imf-transport-v2, a fixed ~36px flex row built
for the old single-row transport. The unified 2-row bar (~72px) overflowed it, so the
BUTTON row was clipped — only the scrub row showed. Fix (CSS): when that row hosts the
bar, `.imf-transport-v2:has(> .pfx-tx-host){ display:block; height:auto; min-height:0;
max-height:none; overflow:visible }` → the row grows to fit. CDP-verified: parH 36→72,
buttonsNotClipped true, barW 980; screenshot shows scrub + full button row. test:js 0-fail; repacked.
