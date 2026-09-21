# CUT DIFF 2.0 — How to Use

**PostFlowX · Editorial Diff & Compare**

---

## Table of Contents

1. [What is Cut Diff 2.0?](#1-what-is-cut-diff-20)
2. [Loading Your Timelines](#2-loading-your-timelines)
3. [Running the Diff](#3-running-the-diff)
4. [Understanding Diff Types](#4-understanding-diff-types)
5. [Risk Scoring](#5-risk-scoring)
6. [Reading the Timeline](#6-reading-the-timeline)
7. [Shot Cuts & How to Spot Them](#7-shot-cuts--how-to-spot-them)
8. [The Diff Table](#8-the-diff-table)
9. [The Inspector Panel](#9-the-inspector-panel)
10. [Video Comparison](#10-video-comparison)
11. [Filters](#11-filters)
12. [Status & Notes Workflow](#12-status--notes-workflow)
13. [Exporting](#13-exporting)
14. [Keyboard Shortcuts](#14-keyboard-shortcuts)
15. [Tips & Workflow Examples](#15-tips--workflow-examples)

---

## 1. What is Cut Diff 2.0?

Cut Diff 2.0 compares two versions of an edited timeline — an **OLD cut** and a **NEW cut** — and shows you exactly what changed between them. It answers:

- Which clips were added, removed, or replaced?
- Which shots were extended or shortened?
- How much screen time was added or removed?
- Which changes are high-risk and need immediate VFX/audio/music attention?

It is designed for **editorial turnover**: VFX coordinators, assistant editors, sound editors, and music supervisors who need to understand a picture lock revision quickly.

**Supported file formats**: EDL (CMX 3600), FCPXML, ALE, XML timeline exports from DaVinci Resolve, Avid, Premiere, and Final Cut Pro X.

---

## 2. Loading Your Timelines

### Drop Zones

At the top of the tab you will see two drop zones:

```
┌────────────────────┐   ┌────────────────────┐
│  Drop OLD Timeline │   │  Drop NEW Timeline  │
│   or click Browse  │   │   or click Browse   │
└────────────────────┘   └────────────────────┘
```

- **Left zone = OLD** — the previous version of the cut (your reference/baseline)
- **Right zone = NEW** — the updated version you received from editorial

Drag-and-drop a file onto each zone, or click **Browse** to pick a file. When a file is loaded its filename appears in the zone and the zone turns highlighted.

### Which file is OLD and which is NEW?

Always load the **earlier** version as OLD and the **later** version as NEW. The diff direction matters: an event is marked EXTENDED when the NEW clip is longer than the OLD clip. If you load them backwards all EXTENDED/TRIMMED labels will be inverted.

### Loading Video Files (optional but recommended)

Below the drop zones is the **Video Compare** panel. You can optionally drop or browse the actual video files for OLD and NEW. This enables:

- Frame-accurate thumbnail filmstrips on the timeline
- Side-by-side / wipe / difference video comparison
- Pixel-level content diff graph under the timeline

Video files are stored in your browser's IndexedDB so they are remembered across sessions. The extension will ask for permission once; after that it restores silently.

---

## 3. Running the Diff

Click the **Analyze** button in the header. This triggers the diff engine which:

1. Parses all clips from both timelines
2. Matches each NEW clip to its best OLD counterpart by **clip identity** (clip name + reel)
3. Classifies each match into a diff type (NEW, EXTENDED, CHANGED, TRIMMED)
4. Computes a **risk score** for each change
5. Renders the KPI bar, timeline, and table

The diff runs entirely in the browser — no upload, no server.

### KPI Bar

After analyzing, a row of metric cards appears:

| Card | What It Shows |
|------|--------------|
| **NEW** | Clips that appear in NEW but have no matching clip in OLD |
| **EXTENDED** | Clips whose duration grew between OLD and NEW |
| **CHANGED** | Same clip name, different source material or take |
| **TRIMMED** | Clips whose duration shrank |
| **HIGH RISK** | Events that need immediate attention (see §5) |
| **+DUR** | Total screen time added (NEW + EXTENDED frames) |
| **−DUR** | Total screen time removed (TRIMMED frames) |
| **% Changed** | What fraction of the cut has changed |

The progress bar at the far right shows the proportion of changed vs unchanged clips at a glance.

---

## 4. Understanding Diff Types

The engine compares each NEW clip against OLD clips with the **same clip name and reel**. When a match is found, the duration and source-in point are compared within a small tolerance (±2 frames duration, ±4 frames source-in) to decide the diff type.

### NEW
```
OLD: [nothing]
NEW: [████████ CLIP_A ████████]
```
The clip exists in NEW but there is **no clip of the same identity** anywhere in OLD. This means editorial either added a new shot, pulled in new material from a different reel, or renamed a clip. All NEW events are automatically **HIGH RISK** because downstream departments (VFX, audio, music, color) have never seen this material before.

### EXTENDED
```
OLD: [████████ CLIP_B ████████]         (200 frames)
NEW: [█████████████ CLIP_B █████████]   (260 frames + 60 frames added)
```
Same clip, but the NEW cut is **longer**. The editor extended the head and/or tail of the shot. This could mean:
- A new beat was added at the start of the shot
- The hold at the end is longer
- An action was given more time to breathe

For VFX this usually means the VFX work window needs to expand. For music/sound, a pre-existing cue may now overlap into the next scene.

### TRIMMED
```
OLD: [█████████████ CLIP_C █████████]   (180 frames)
NEW: [████ CLIP_C ████]                  (80 frames — 100 frames removed)
```
Same clip, but the NEW cut is **shorter**. The editor tightened the shot. For VFX, work may now start later or end earlier than budgeted. For audio/music, the picture may have gone tighter than a composed cue intended.

### CHANGED
```
OLD: [████ CLIP_D (srcIn=00:42:15:00) ████]
NEW: [████ CLIP_D (srcIn=01:12:30:08) ████]   same name, completely different source
```
Same clip name, but the source timecode (srcIn) differs by more than the tolerance. This indicates:
- A different **take** of the same scene
- A **retimed** or **re-graded** version with a different start point
- A **replaced** clip that happens to share the name

CHANGED events require review because the content is visually different even though the slot in the cut is the same.

### UNCHANGED
```
OLD: [████ CLIP_E ████]  (srcIn=00:10:00:00, dur=120fr)
NEW: [████ CLIP_E ████]  (srcIn=00:10:00:00, dur=120fr) — identical
```
The clip is the same in both cuts within tolerance. By default, UNCHANGED events are **hidden** from the table to keep the view focused on what actually changed. You can show them by using the filter if needed.

---

## 5. Risk Scoring

Every diff event gets a risk level based on what it means for downstream work.

### Risk Levels

| Level | Color | Rule |
|-------|-------|------|
| **HIGH** | 🔴 Red | Any NEW event **or** any event lasting more than 240 frames (~10 s at 24fps) |
| **MED** | 🟡 Amber | Event duration is 48–240 frames (~2–10 seconds) |
| **LOW** | 🟢 Green | Event duration is under 48 frames (~2 seconds) |

### Why 240 frames?

A cut that changes a 10-second section is categorically different from a 2-frame tail trim. At 10 seconds you likely have:
- A full VFX shot that needs re-delivery
- A music cue whose timing is broken
- A dialogue scene with ADR implications
- A color grade that needs new frames

The 240-frame (10s) threshold is the heuristic boundary where a change stops being a "tweak" and becomes a significant structural change.

### Match Score (Confidence %)

For EXTENDED, CHANGED, and TRIMMED events, the engine also reports a **match confidence** between 0–100%:

- **100%**: Perfect match — duration and source-in are identical
- **75–99%**: Small trim or minor source adjustment — high confidence it's the same shot
- **50–74%**: Moderate difference — worth double-checking
- **< 50%**: Large divergence — may be an incorrect match

The score is calculated as:  
`(duration similarity × 60%) + (source-in similarity × 40%)`

Duration similarity weighs more heavily because duration differences are the most impactful for downstream deliverables.

---

## 6. Reading the Timeline

The timeline is the most powerful part of Cut Diff 2.0. It shows **both** the OLD and NEW cuts side by side as horizontal tracks.

### Timeline Layout (top to bottom)

```
┌─────────────────────────────────────────────────────────────┐
│ RULER  │ 00:00   00:30   01:00   01:30   02:00              │ ← Timecode ruler
├────────────────────────────────────────────────────────────┤
│                                                              │
│  OLD ░░░░▓▓▓▓▓░░▓▓▓▓░░░░░░▓▓░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░░  │ ← OLD timeline track
│                                                              │
│ ─────────────────── DIFF ──────────────────────────────────── │ ← Diff separator
│                                                              │
│  NEW ░░░▓▓▓▓░░░░░░░▓▓▓▓▓▓░░░▓░░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░  │ ← NEW timeline track
│                                                              │
│ ▓▓▓░░░░▓▓▓░▓░▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ ← Summary strip
├────────────────────────────────────────────────────────────┤
│ Content diff ░░▓░░░░░░▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ ← Pixel diff graph
└─────────────────────────────────────────────────────────────┘
```

### The Ruler

The top row shows timecodes in **MM:SS** format. The ruler adjusts its tick density automatically as you zoom — at wide zoom you see 60-second intervals, at tight zoom you see 5-second intervals.

### OLD Track

Displays the OLD timeline as a filmstrip. If you have loaded a video file:
- Each clip region shows **thumbnail frames** extracted from the actual video
- Thumbnails are extracted at the clip's `RecIn` timecode
- A **selected event** shows an amber glow border around its clip region

If no video is loaded, clips appear as plain colored blocks.

### DIFF Separator

The thin band between tracks shows the label "DIFF" and visually separates OLD from NEW. The colored bars at the bottom of each clip in the NEW track are the diff type markers (see below).

### NEW Track & Diff Color Bars

The NEW track shows each clip with a **colored bar at the bottom** indicating its diff status:

| Color | Diff Type | Meaning |
|-------|-----------|---------|
| 🔵 Bright cyan | NEW | Never seen before — not in OLD |
| 🟢 Green | EXTENDED | This clip grew vs OLD |
| 🟡 Amber | CHANGED | Same name, different source/take |
| 🟣 Purple | TRIMMED | This clip shrank vs OLD |
| ⬛ Very dark | UNCHANGED | Identical to OLD |

A **2px red stripe at the top** of a clip means HIGH RISK (NEW or long duration).

### Summary Strip

The thin colored bar below the NEW track is a compressed view of the entire cut. It lets you see at a glance where changes are clustered — for example, if the last act has a dense band of amber, editorial heavily revised that section.

### Content Diff Graph

The bar graph below the summary strip shows **pixel-level frame similarity** between OLD and NEW. For each moment in time, it computes the average pixel difference between the corresponding OLD and NEW frames.

| Color | Meaning |
|-------|---------|
| 🟢 Green bars | Frames look almost identical |
| 🟡 Amber bars | Moderate visual difference |
| 🔴 Red bars | Frames are visually very different |

This graph reveals things the EDL-level diff cannot: a clip could have the same timecode and duration but completely different content (e.g., a grade change, a VFX shot revision, or a pick-up replace with similar duration). Where the graph spikes red with no matching CHANGED/NEW event in the diff table, investigate the footage — the editor may have swapped material without renaming clips.

The content diff only appears when **both video files** are loaded.

---

## 7. Shot Cuts & How to Spot Them

### What Is a "Shot Cut" in the Context of Cut Diff?

A shot cut is any moment where the OLD and NEW cuts diverge at a specific edit point — where a cut happens in NEW that didn't happen in OLD, or vice versa. These structural changes are the most impactful for downstream work.

### How to See Shot Cuts in the Timeline

**Method 1: Look at the start/end points of clips in the NEW track**

When the colored diff bars on adjacent clips are different types, there is a meaningful edit point change. For example:

```
OLD: [───────── CLIP_A ─────────][── CLIP_B ──]
NEW: [── CLIP_A ──][NEW CLIP_X ─][── CLIP_B ──]
```
In this case, CLIP_A was trimmed and a new shot (CLIP_X) was inserted in the middle. In the timeline you will see:
- CLIP_A with a purple (TRIMMED) bar
- CLIP_X with a cyan (NEW) bar
- CLIP_B as unchanged (dark)

**Method 2: Zoom into a changed section**

Use **scroll wheel to zoom** on the timeline. As you zoom in, the ruler ticks get finer and individual shots become visible. You can read exact timecodes from the ruler to know precisely where in the reel each change lives.

**Method 3: Watch for clusters in the summary strip**

The summary strip shows the whole cut compressed to one bar. A cluster of colors (cyan/amber/green) means a dense revision zone. Click on the strip or zoom into that area to examine the individual shots.

**Method 4: Compare OLD and NEW clip edges directly**

Select a TRIMMED event in the table. The inspector shows both the OLD and NEW `RecIn`/`RecOut` values. The difference is how much the cut point moved. For example:
- OLD RecOut: `01:02:15:00`
- NEW RecOut: `01:02:12:08`

This tells you the shot end moved **2 seconds 8 frames earlier** in the new cut.

### NEW Clips Inserted Between Existing Shots

When NEW clips appear between known clips, the record-in timecodes of subsequent clips will shift. Example:

```
OLD:  [──A──|──B──|──C──]     B starts at 01:00:00:00
NEW:  [──A──|NEW X|──B──|──C──]   B now starts at 01:00:12:00
```

B in the NEW cut is UNCHANGED (same content) but appears LATER in the program. The diff engine correctly marks X as NEW and B as UNCHANGED. However, B's new `RecIn` timecode in the inspector shows you it has shifted by 12 seconds. This matters for:
- **Music editors**: A cue hitting on B's action beat is now 12 seconds late
- **Sound editors**: Foley and effects synced to B need retime
- **VFX**: Any VFX shot on B now plays at a different program position

### Replaced Shots (CHANGED)

CHANGED events are the most nuanced. The clip name matches but the source is different. In the timeline the amber bar appears in the same position as before, so it can look like nothing changed structurally. But when you click the event and open the inspector:

- **Old SrcIn** vs **SrcIn** shows how far the source window moved
- **Match Score** below 50% means the editor likely chose a completely different take

To confirm visually, use the **video compare panel** with the Chain mode to line up the OLD and NEW source simultaneously (see §10).

---

## 8. The Diff Table

The table lists every changed event as a row.

### Column Guide

| Column | Description |
|--------|-------------|
| **●** | Risk pip — red (high), amber (med), green (low) |
| **Type** | NEW / EXT / CHG / TRM / UNC badge |
| **Reel** | Reel or bin name from the EDL/XML |
| **Clip** | Clip name |
| **SrcIn** | Source timecode in |
| **Dur** | Duration in frames |
| **Match%** | Confidence score (bar + %) — blank for NEW events |
| **Status** | Your review status: — / ✓ / ⊘ / ? (click to cycle) |
| **Note** | Free-text note field (visible in inspector) |

### Selecting a Row

Click any row to:
1. **Open the inspector** (right panel) with full event details
2. **Zoom the timeline** to center that event
3. **Seek the video** to the event's `RecIn` timecode (if video loaded)

The active row is highlighted in amber.

### Sorting & Reading Order

Rows appear in **record-in timecode order** (program order) by default — the same order they appear in the cut. This makes it easy to walk through the diff in editorial sequence from scene 1 to end.

---

## 9. The Inspector Panel

Click any row to open the inspector on the right side. It shows a complete breakdown of the selected change.

### Fields

```
Event 3 / 47                 ← event number out of total
Type:    EXTENDED             ← diff classification
Reel:    A001                 ← reel name
Clip:    105_08_06/01_AB      ← clip name
SrcIn:   10:42:15:00          ← source start in NEW
SrcOut:  10:42:28:10          ← source end in NEW
RecIn:   01:02:45:00          ← record (program) start
RecOut:  01:02:58:10          ← record (program) end
Duration: 318 frames
FPS:      24
```

### Match Info (for EXTENDED / TRIMMED / CHANGED)

```
Match Score:  ████████░░  78%   ← confidence bar
Reason:       Duration +48fr (+2.0s extended)
Old Clip:     105_08_06/01_AB   ← same clip in OLD
Old SrcIn:    10:42:15:00       ← source start in OLD
Old RecIn:    01:02:45:00       ← record start in OLD
```

### Reading the Match Score Bar

- **Full green bar (≥75%)**: High confidence — the engine matched the correct clip
- **Amber bar (≥50%)**: Moderate confidence — verify the match visually
- **Red bar (<50%)**: Low confidence — the clip may have been matched to a similar-named clip by mistake; check manually

When the score is low for a CHANGED event, it usually means the clip was substantially replaced and what you are seeing is a brand-new source even though the slot looks similar.

### Status & Notes

The inspector lets you mark each event and write a note. Both persist across sessions.

**Status states** (click or press Enter to cycle):
- **—** (none): Not reviewed yet
- **✓** (ok): Confirmed, no action needed
- **⊘** (skip): Known issue, skip in this pass
- **?** (query): Needs follow-up or discussion

Notes appear in both the PDF and XLSX exports, so you can write a one-liner for the editor or VFX supervisor directly in this field.

---

## 10. Video Comparison

Load video files for OLD and NEW to unlock the full comparison panel.

### How to Load Videos

1. Expand the **Video Compare** section
2. Click **Browse OLD** / **Browse NEW** or drag-drop directly onto the upper/lower half of the timeline canvas
3. The extension stores the file handle in IndexedDB — on next session it will silently re-open without a prompt

### Compare Modes

Select a mode using the buttons at the top of the compare panel:

#### Wipe
A vertical slider divides the screen. Drag the slider left/right to reveal OLD (left) or NEW (right). The split point percentage is shown in the HUD. Use this to compare head frames, action beats, and framing changes.

#### Side by Side (SBS)
OLD plays on the left half, NEW on the right half simultaneously. Both play in sync. Good for comparing pacing and energy across cuts.

#### Split
Like SBS but each video fills its half completely (cropped). Use this when you want to compare composition and framing without black bars.

#### AB
Shows one video at a time full-screen. Click the canvas to toggle between A (OLD) and B (NEW). A/B is the fastest way to spot a changed take — quickly toggle back and forth to see if the performance or framing is different.

#### Diff
Shows a pixel-by-pixel **difference image**: pixels that are identical appear black, pixels that differ appear bright white/yellow. Any area that glows is a change. This is especially useful for detecting:
- Reframing / reposition
- Color grade changes
- VFX revisions
- Subtitle/burn-in changes

The HUD shows "Diff X.X%" — the percentage of pixels that changed. A brand-new shot will be 90–100%. A regraded shot with the same composition will be 30–50%.

#### Heat
Like Diff but color-coded by magnitude:
- 🟢 Green: Small change
- 🟡 Amber: Medium change
- 🔴 Red: Large change

Good for finding the epicenter of a revision (e.g., a VFX element that changed in one corner of frame while the background stayed the same).

### Fit Mode

Toggle between **Contain** (letterbox, preserves aspect ratio) and **Cover** (fills canvas, crops).

### Chain Mode

When Chain is enabled, the OLD video automatically seeks to the **OLD clip's source-in** when you select an event, while NEW seeks to the NEW clip's source-in. This means you are always comparing OLD take vs NEW take at the cut point simultaneously, even if the two timecodes are completely different.

Use Chain when reviewing CHANGED events where editorial switched to a different take.

### Scrubbing to a Specific Frame

Click anywhere on the scrubber bar to jump to that position. The timeline cursor (amber vertical line) stays in sync with playback.

### Keyboard Controls During Playback

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| ← | Step back 1 frame |
| → | Step forward 1 frame |

---

## 11. Filters

### Type Filter

Click the pill buttons to show only a specific diff type:

`ALL` `NEW` `EXTENDED` `CHANGED` `TRIMMED`

For example, click **NEW** to see only newly inserted shots — the table will hide everything else and the timeline will also highlight only NEW events.

### Risk Filter

`all` `high` `med` `low`

Click **high** to see only high-risk events. This is the recommended starting point for any turnover review — address all HIGH RISK changes first before reviewing medium/low risk items.

### Using Filters Together

Filters combine: type filter AND risk filter both apply. To see all high-risk changes that aren't NEW shots (i.e., existing shots that are dangerously long now), set type=EXTENDED and risk=high.

---

## 12. Status & Notes Workflow

The Status system is designed for tracking your review progress through a turnover.

### Recommended Review Pass

1. **Filter to HIGH RISK** → review all HIGH items → mark as ✓ (ok) or ? (query)
2. **Filter to CHANGED** → check each take replacement → note if VFX re-do is needed
3. **Filter to NEW** → confirm new shots with coordinator → note pull/delivery dates
4. **Filter to EXTENDED** → check if any VFX shots grew beyond budget
5. **Filter to TRIMMED** → confirm deliverables still fit within the trimmed window

### Status Meanings in Practice

| Status | When to Use |
|--------|-------------|
| **—** | Haven't reviewed yet |
| **✓ ok** | Reviewed, no action needed, safe to proceed |
| **⊘ skip** | Known / intentional, skip in this session |
| **? query** | Need to ask the editor / coordinator before acting |

### Notes in Exports

Notes appear in:
- **PDF Report**: Shown inside the event card
- **XLSX**: In the Note column of the Change List sheet

Write concise, actionable notes: e.g., _"VFX shot A043 now 12fr longer — update delivery spec"_ or _"New take, check ADR — dialog changes"_.

---

## 13. Exporting

Click the amber **Export ▾** button to open the export menu.

### Pull EDL

Generates a CMX 3600 EDL containing only the **NEW, CHANGED, and EXTENDED** events. Use this to send to an online suite, conform, or VFX pull system so they can locate only the changed material.

- Events with status **⊘ skip** are excluded from the pull
- Very large timelines auto-split into multiple EDL parts

### PDF Report

Opens a print-ready PDF in a new browser tab with:
- **Summary header**: Project name, OLD/NEW file names, date, stat chips (NEW count, EXTENDED count, etc.)
- **Change cards**: One card per changed event, grouped by type
  - Thumbnail frame (from video cache, or grey placeholder)
  - Type badge + risk badge + match score
  - All timecodes and duration
  - Your status and note
- **Audio Change List**: A separate table at the bottom sorted by program timecode, listing all clips that match audio track naming conventions (MX, SFX, DIA, ADR, VO, FOLEY, etc.)

Click the **Print / Save PDF** button at the top of the popup to save as PDF.

### XLSX Change List

Exports a proper `.xlsx` workbook (4 sheets) that opens natively in Excel and Numbers with **embedded thumbnail images**:

| Sheet | Contents |
|-------|----------|
| **Change List** | All changed events with 120×68 frame thumbnail in column D, colored type/risk cells |
| **Audio Ref** | All events sorted by RecIn, flagged for audio relevance |
| **Removed** | Clips present in OLD but missing from NEW (potential conforms needed) |
| **Summary** | Stats overview: counts, durations |

Color coding in the XLSX:
- 🟦 Blue fill = NEW
- 🟩 Green fill = EXTENDED
- 🟨 Amber fill = CHANGED
- 🟪 Purple fill = TRIMMED
- 🟥 Red fill = REMOVED / HIGH RISK

---

## 14. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↓` or `J` | Next event in table |
| `↑` or `K` | Previous event in table |
| `Enter` | Cycle status of selected event |
| `Escape` | Close inspector panel |
| `Space` | Play / Pause video |
| `←` | Step back 1 frame |
| `→` | Step forward 1 frame |

Shortcuts only activate when the CUT DIFF 2.0 tab is active and focus is not on a text input.

---

## 15. Tips & Workflow Examples

### Tip 1: Work from the Timeline Outward

Don't start in the table — start in the timeline. The summary strip shows you where changes are clustered. Zoom into a dense cluster, find the shot boundaries, then click individual events to drill down into the inspector.

### Tip 2: Use Wipe Mode to Check Framing Changes

A CHANGED event with a high match score (>75%) often means the editor used a slightly different start frame — perhaps 12 frames later in the take. Switch to Wipe mode and scrub to the first frame of the shot. Does the framing match? If not, the content is meaningfully different and needs a new VFX plate.

### Tip 3: Watch the Content Diff Graph for Silent Replaces

The content diff graph catches changes the EDL cannot. If you see a spike in the graph under a region that shows no colored bar in the NEW track, the clip name/timecodes are identical but the content is visually different. This happens when:
- A grade was burned in before export
- A VFX shot was replaced with the same handle frames
- An offline was used and the online frame range shifted slightly

Flag these for manual review.

### Tip 4: Filter HIGH + CHANGED for Most Complex Issues

The combination of high risk AND CHANGED type is the most demanding scenario: an existing long shot was replaced with a different take. This affects VFX (new plate), music (the scene may feel different energetically), and ADR (different performance = different lip sync). Set type=CHANGED and risk=high to isolate these.

### Tip 5: Use Notes as Delivery Memos

Type your action item directly into the Note field as you review. When you export the XLSX, every note is in the spreadsheet — ready to share with the VFX coordinator or music editor as a formatted turnover document with no extra work.

### Tip 6: The AB Mode for Take Comparison

When reviewing CHANGED events, enter AB mode, select the event, and rapidly press the canvas to toggle A/B. Because Chain mode aligns both videos to the shot start, you are toggling between OLD take and NEW take of the exact same scene. This is the fastest way to judge whether a take change matters for your department.

### Tip 7: Multi-Part EDL for Large Conforms

If your sequence has more than 1,500 changed events, the Pull EDL export automatically splits into multiple files (Part1, Part2, …). Online suites have per-EDL event limits, so this prevents import failures.

---

*How to Use last updated: April 2026 · PostFlowX · CUT DIFF 2.0*
