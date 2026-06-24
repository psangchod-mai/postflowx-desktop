# Pull Prep 2.0 — How to Use

**Version:** PostFlowX Pull Prep 2.0  
**Scope:** Complete guide to importing, navigating, and exporting from the Pull Prep (EDL) tab.

---

## Table of Contents

1. [Overview](#overview)
2. [Importing Files](#importing-files)
3. [The Event Table](#the-event-table)
4. [The Inspector Panel](#the-inspector-panel)
5. [The Timeline Viewport](#the-timeline-viewport)
6. [The Minimap](#the-minimap)
7. [Quick Settings (QS) Modes](#quick-settings-qs-modes)
8. [Handles & Storage](#handles--storage)
9. [Exporting](#exporting)
10. [Keyboard Shortcuts Reference](#keyboard-shortcuts-reference)
11. [Mouse Reference](#mouse-reference)
12. [Trackpad Reference](#trackpad-reference)

---

## Overview

Pull Prep 2.0 is the core pull-list tool inside PostFlowX. It parses editorial timelines, maps each event back to its OCF (original camera file) reel, applies non-linear handles, and exports pull lists for vault / DIT.

The tab is split into four zones:

```
┌─────────────────────────────────────────────────────┐
│  KPI bar  │  Context  │  Quick Settings              │
├──────────────────────┬──────────────────────────────-┤
│                      │                               │
│   Event Table        │   Inspector Panel             │
│                      │                               │
├──────────────────────┴───────────────────────────────┤
│                 Timeline Viewport                     │
├──────────────────────────────────────────────────────┤
│                     Minimap                          │
└──────────────────────────────────────────────────────┘
```

---

## Importing Files

### Supported Formats

| Format       | Extension(s)                        | Notes                                       |
|-------------|-------------------------------------|---------------------------------------------|
| EDL          | `.edl`                              | CMX 3600 standard                           |
| FCPXML       | `.fcpxml`, `.xml`, `.fcpxmld`       | Final Cut Pro X export                      |
| OTIO         | `.otio`                             | OpenTimelineIO (DaVinci Resolve export)     |
| AAF          | `.aaf`                              | Avid Media Composer                         |
| ALE          | `.ale`                              | Avid Log Exchange (metadata only)           |

### Method 1 — Drag and Drop

1. Open the **PULL PREP** tab.
2. Drag any supported file directly onto the **event table area** or the **timeline area**.
3. The file parses instantly. The event table, KPI bar, and timeline all populate.

### Method 2 — Browse Button

1. Click the **Browse / Import** button (folder icon, top-left of the tab).
2. Select a file. The file dialog filters to supported types automatically.

### Method 3 — Match Back ALE Drop

If you have an ALE (Avid Log Exchange) file with camera metadata:

1. Load your EDL/FCPXML first.
2. Drag the `.ale` file onto the event table.
3. PostFlowX matches ALE rows to events by reel name and fills in missing metadata (camera, magazine, scene, etc.) without overwriting timecode.

### After Import

- **KPI bar** shows: total clips, unique reels, total duration, total storage estimate.
- **Event table** lists every event with reel, timecode, and camera.
- **Timeline viewport** renders all tracks visually.

---

## The Event Table

### Reading the Columns

| Column     | Content                                                      |
|------------|--------------------------------------------------------------|
| `#`        | Event number (from original EDL/XML)                         |
| Cam dot    | Colored dot = camera letter (A, B, C…)                       |
| Reel       | OCF camera reel stem (e.g., `A083C016_250612M5`)             |
| Clip       | Editorial clip name                                          |
| Src In     | Source timecode in                                           |
| Src Out    | Source timecode out                                          |
| Dur        | Duration in frames                                           |
| Rec In     | Record (sequence) timecode in                                |
| Rec Out    | Record timecode out                                          |
| Storage    | Estimated raw storage for this event's pull range            |
| Loc        | Locator / marker label (if present)                          |

### Selecting Rows

| Action                          | Result                                          |
|---------------------------------|-------------------------------------------------|
| Click a row                     | Select single event, populate Inspector         |
| Shift + Click                   | Range-select from last anchor to clicked row    |
| Cmd/Ctrl + Click                | Add/remove individual row to selection          |
| Cmd/Ctrl + A                    | Toggle select all                               |
| Arrow Up / Down (table focused) | Move selection up/down one row                  |
| Shift + Arrow Up/Down           | Extend range selection                          |
| Shift + Page Up / Page Down     | Extend selection by page                        |
| Shift + Home / End              | Extend selection to top / bottom                |
| Space                           | Toggle checkbox on focused row                  |
| Shift + Space                   | Toggle checkboxes for entire range              |

### Sorting

Click any **column header** to sort by that column.  
Click the same header again to reverse sort order (ascending ↔ descending).  
An arrow indicator shows the active sort direction.

### Resizing Columns

Drag the **resize handle** (thin vertical line) on the right edge of any column header.  
The column width is remembered until you resize again.  
Minimum width: 60 px per column.

### The "Only" Toggle

Some column headers have a small **"Only"** chip. Clicking it hides all other events and shows only events matching that column value — useful to quickly isolate all B-camera events or all events from one reel.

### Scrolling the Table

- **Scroll wheel** — vertical scroll
- **Shift + Scroll wheel** — horizontal scroll (if columns overflow)
- Dragging the scrollbar works normally

---

## The Inspector Panel

The Inspector shows the full metadata for whichever event is selected in the table.

### Handles Field

The **Handles** field at the top of the Inspector controls how many extra frames are added to each pull:

- Type a value directly into the handle field and press **Enter**.
- The Src In / Src Out in the table instantly update to reflect the padded range.
- Storage estimate recalculates.

### Non-Linear Handles

When **Retime Handles+** Quick Setting is active, handles are applied non-linearly — reel segments near existing clips get shorter handles automatically to avoid overlap, while isolated clips get full handles.

### Metadata Fields

Editable fields in the Inspector include:
- **Camera** (letter A–Z)
- **Scene** / **Take** / **Shot**
- **Locator** label

Changes are local to the session and exported with the pull list.

---

## The Timeline Viewport

The timeline renders every event as a colored block on its track. It is fully interactive.

### Navigating the Timeline

#### Zoom

| Action                     | Result                         |
|----------------------------|--------------------------------|
| Cmd/Ctrl + `=` or `+`      | Zoom in (×1.25, max ×8)        |
| Cmd/Ctrl + `-`             | Zoom out (÷1.25, min ×1)       |
| Cmd/Ctrl + `0`             | Fit entire timeline to window  |
| `Z` then `↑`               | Zoom in (Z-mode, 900 ms window)|
| `Z` then `↓`               | Zoom out (Z-mode, 900 ms window)|

> **Z-mode tip (NLE shortcut):** Press and release `Z`, then immediately press `↑` or `↓`. You have 900 ms after releasing Z to use the arrow.

#### Panning

| Action                     | Result                          |
|----------------------------|---------------------------------|
| Alt + `←` / `→`           | Pan timeline left/right (120 px)|
| Drag the minimap window    | Pan to any position instantly   |
| Scroll the viewport        | Vertical track scroll           |

#### Playhead

| Action                               | Result                          |
|--------------------------------------|---------------------------------|
| Click anywhere on the **ruler**      | Jump playhead to that time      |
| Drag on the **ruler**                | Scrub playhead continuously     |
| `←` / `→`                           | Nudge playhead ±1 frame         |
| `Shift + ←` / `Shift + →`           | Nudge playhead ±10 frames       |
| `,` (comma)                          | Fine nudge −1 frame             |
| `.` (period)                         | Fine nudge +1 frame             |
| `Home`                               | Jump to sequence start          |
| `End`                                | Jump to sequence end            |
| `↑`                                  | Previous clip on same track     |
| `↓`                                  | Next clip on same track         |

### Interacting with Clips

| Action                  | Result                                             |
|-------------------------|----------------------------------------------------|
| Click a clip bar        | Select that event (highlights table row too)       |
| Right-click a clip bar  | Context menu: Enable / Disable / Delete event      |
| Double-click track grip | Reset track height to default (18 px)              |
| Drag track resize grip  | Resize that track's height                         |
| Drag timeline divider   | Resize split between event table and timeline      |

### Track Height

Drag the **resize grip** (bottom edge of each track lane) to make a track taller or shorter.  
**Double-click** the grip to snap back to the default 18 px height.

### Shortcut Overlay

Press **`?`** (or `Shift + /`) while the EDL tab is active to show the full keyboard shortcut overlay.

---

## The Minimap

The minimap is the thin horizontal bar below the timeline. It shows the entire sequence at a 1:1 compressed scale.

### Reading the Minimap

- Colored blocks = events (track color)
- **White/light rectangle** = the current viewport window (what you're zoomed into)

### Navigating with the Minimap

| Action                          | Result                                      |
|---------------------------------|---------------------------------------------|
| Click anywhere on the minimap   | Jump viewport scroll to that position       |
| Drag the viewport window        | Pan the timeline view smoothly              |

> **Trackpad tip:** On a MacBook trackpad, two-finger swipe left/right while hovering over the minimap scrolls the timeline horizontally.

---

## Quick Settings (QS) Modes

Quick Settings are toggleable presets that change how events are displayed, renamed, or exported. They appear as a row of buttons above the event table.

Click a QS button to activate it. Click again to deactivate. Only contextually compatible settings can be active simultaneously.

Click **All OFF** to reset all QS settings.

### Available Modes

| Button          | What it does                                                                   |
|-----------------|--------------------------------------------------------------------------------|
| **Conform**     | Marks events by whether their reel is present in the loaded ALE/media          |
| **VFX Rename**  | Renames reel column output to VFX shot naming convention                       |
| **VFX Marker**  | Adds VFX locator annotations based on shot markers from the Markers tab        |
| **Match Back**  | Opens the Match Back modal — maps proxy clip names back to OCF reels           |
| **Merge**       | Merges adjacent events on the same reel into a single pull range               |
| **Flatten**     | Collapses multi-track events to a single track representation                  |
| **Decompose**   | Splits merged/stacked events into individual per-track entries                 |
| **Auto Split**  | Automatically splits events that span a cut point on a different track         |
| **Metadata**    | Shows expanded metadata columns (scene, take, magazine, etc.)                  |
| **DF→NDF**      | Converts all drop-frame timecodes to non-drop-frame                            |
| **Retime Handles+** | Applies non-linear handles (shorter where clips are dense)                |

---

## Handles & Storage

### Setting Handles

Handles add frames before and after each event's source timecode to give editors and colorists room to trim.

1. Find the **Handles** field in the Inspector panel (right side).
2. Type the number of frames (e.g., `24` for 1 second at 24fps).
3. Press **Enter** or click away — the table and storage estimates update immediately.

### Storage Estimate

Each row in the event table shows a **Storage** column with the estimated file size for that pull.

- Estimates are calculated from the pull duration × codec data rate.
- The **KPI bar** at the top shows the total estimated storage across all checked events.
- Only checked (✓) events are counted in the total.

---

## Exporting

### Export Formats

Click the **Export** button (top-right area) to access:

| Export Type          | What it produces                                           |
|---------------------|------------------------------------------------------------|
| **Pull List CSV**    | One row per event: reel, timecode, handles, duration, storage |
| **ALE**             | Avid Log Exchange with all event metadata                  |
| **EDL**             | Regenerated CMX 3600 EDL from current event state          |
| **FCPXML**          | Final Cut Pro XML with current edits applied               |
| **AE Script (JSX)** | After Effects project import script per shot               |
| **Nuke (.nk)**      | Per-shot Nuke scripts with correct timecode ranges         |
| **Nuke Python**     | Python script for Nuke batch import                        |

### Exporting Only Selected Events

Check the **checkboxes** on the rows you want, then export. Only checked events are included.  
Use **Cmd/Ctrl + A** to select all, then uncheck specific exceptions.

---

## Keyboard Shortcuts Reference

### Global (any subtab)

| Shortcut            | Action             |
|---------------------|--------------------|
| `Cmd/Ctrl + Z`      | Undo               |
| `Cmd/Ctrl + Shift + Z` | Redo            |
| `Cmd/Ctrl + Y`      | Redo               |

### Event Table Navigation

| Shortcut                   | Action                              |
|----------------------------|-------------------------------------|
| `↑` / `↓`                  | Move row focus up/down              |
| `Shift + ↑` / `↓`          | Extend row range selection          |
| `Ctrl/Cmd + Shift + ↑` / `↓` | Additive range selection          |
| `Shift + Page Up/Down`     | Extend selection by page            |
| `Shift + Home` / `End`     | Extend selection to first/last row  |
| `Space`                    | Toggle checkbox on focused row      |
| `Shift + Space`            | Toggle checkboxes for range         |
| `Cmd/Ctrl + A`             | Select / deselect all               |

### Timeline Zoom & Navigation

| Shortcut                  | Action                            |
|---------------------------|-----------------------------------|
| `Cmd/Ctrl + =` / `+`      | Zoom in                           |
| `Cmd/Ctrl + -`            | Zoom out                          |
| `Cmd/Ctrl + 0`            | Fit timeline                      |
| `Z` → `↑`                 | Zoom in (Z-mode)                  |
| `Z` → `↓`                 | Zoom out (Z-mode)                 |

### Playhead Movement

| Shortcut              | Action                      |
|-----------------------|-----------------------------|
| `←` / `→`            | Nudge ±1 frame              |
| `Shift + ←` / `→`    | Nudge ±10 frames            |
| `,`                   | Fine nudge −1 frame         |
| `.`                   | Fine nudge +1 frame         |
| `↑`                   | Jump to previous clip       |
| `↓`                   | Jump to next clip           |
| `Alt + ←` / `→`      | Pan timeline view ±120 px   |
| `Home`                | Go to sequence start        |
| `End`                 | Go to sequence end          |

### Help

| Shortcut   | Action                    |
|------------|---------------------------|
| `?`        | Show shortcut overlay     |

---

## Mouse Reference

### Event Table

| Interaction                    | Result                                    |
|--------------------------------|-------------------------------------------|
| Click row                      | Select event, show in Inspector           |
| Shift + click row              | Range-select                              |
| Cmd/Ctrl + click row           | Toggle individual row in selection        |
| Click column header            | Sort by column (click again to reverse)   |
| Drag column resize handle      | Resize column width                       |
| Click "Only" chip on header    | Isolate events matching that column value |
| Scroll wheel                   | Vertical scroll                           |
| Shift + scroll wheel           | Horizontal scroll                         |

### Timeline

| Interaction                    | Result                                    |
|--------------------------------|-------------------------------------------|
| Click ruler                    | Jump playhead                             |
| Drag ruler                     | Scrub playhead                            |
| Click clip bar                 | Select that event                         |
| Right-click clip bar           | Context menu (Enable / Disable / Delete)  |
| Drag track resize grip         | Resize track height                       |
| Double-click track resize grip | Reset track to default height             |
| Drag timeline divider          | Resize event-table / timeline split       |
| Click minimap                  | Jump viewport scroll to position          |
| Drag minimap viewport window   | Pan timeline view                         |

---

## Trackpad Reference

These gestures apply on Apple MacBook trackpad and Magic Trackpad.

### Event Table

| Gesture                        | Result                    |
|--------------------------------|---------------------------|
| Two-finger scroll (vertical)   | Scroll event table        |
| Two-finger scroll (horizontal) | Horizontal scroll (wide tables) |
| Pinch (if OS-level zoom active)| Zooms entire browser view (not timeline-specific) |

### Timeline Viewport

| Gesture                              | Result                                  |
|--------------------------------------|-----------------------------------------|
| Two-finger scroll (vertical)         | Scroll tracks vertically                |
| Two-finger scroll (horizontal)       | Pan timeline left/right                 |
| Two-finger scroll on minimap (horizontal) | Pan timeline view via minimap    |

### Zoom (Keyboard + Trackpad Combo)

PostFlowX timeline zoom is keyboard-driven. The fastest trackpad workflow is:

1. Use `Cmd + 0` to fit → then `Cmd + =` / `Cmd + -` to adjust level.
2. Use **two-finger horizontal swipe** on the minimap to pan to your area of interest without losing zoom level.

> **Pro tip:** Hold `Alt` and press `←` / `→` to nudge the viewport 120 px at a time — useful when the minimap is too coarse and you want fine positional control.

---

## Tips & Workflows

### Workflow: Load EDL + ALE Metadata Merge

1. Drag `.edl` onto Pull Prep tab → events populate.
2. Drag `.ale` (from camera department) onto the event table → metadata fills in (camera, magazine, scene/take).
3. Check all rows → click **Export → Pull List CSV**.

### Workflow: Multi-Camera Isolation

1. Load FCPXML from DaVinci Resolve or FCP.
2. Click the **Camera** column header to sort by camera letter.
3. Click the **"Only"** chip on a camera row to isolate that camera's events.
4. Check all visible rows → export a camera-specific pull list.

### Workflow: VFX Pull with Handles

1. Load your EDL.
2. Enable **VFX Rename** in Quick Settings.
3. Set handles to `48` (2 sec at 24fps) in the Inspector.
4. Enable **Retime Handles+** to prevent overlap on dense sequences.
5. Export → **Nuke (.nk)** or **Pull List CSV** for VFX team.

### Workflow: Match Back from Proxy

1. Load the proxy EDL (offline cut).
2. Click **Match Back** in Quick Settings.
3. In the modal, drop the original OCF file list or ALE.
4. PostFlowX maps proxy clip names → OCF reels and updates the table.
5. Export the OCF pull list.
