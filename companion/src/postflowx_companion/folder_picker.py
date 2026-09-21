from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def _osascript(script: str, timeout: int = 120) -> str | None:
    """Run an AppleScript one-liner and return stdout stripped, or None on error/cancel."""
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
        out = r.stdout.strip()
        return out if out else None
    except Exception:
        return None


def _tkinter_pick_folder(title: str) -> str | None:
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(title=title)
    finally:
        root.destroy()
    return (selected or "").strip() or None


def _tkinter_pick_file(title: str, filetypes: list[tuple[str, str]] | None) -> str | None:
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askopenfilename(
            title=title,
            filetypes=filetypes or [
                ("Video files", "*.mov *.mp4 *.mxf *.avi *.r3d *.mts *.m2t *.m2ts *.mkv *.m4v"),
                ("All files", "*.*"),
            ],
        )
    finally:
        root.destroy()
    return (selected or "").strip() or None


def _tkinter_pick_files(title: str, filetypes: list[tuple[str, str]] | None) -> list[str]:
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askopenfilenames(
            title=title,
            filetypes=filetypes or [
                ("Video files", "*.mov *.mp4 *.mxf *.avi *.r3d *.mts *.m2t *.m2ts *.mkv *.m4v"),
                ("All files", "*.*"),
            ],
        )
    finally:
        root.destroy()
    return [str(Path(p).expanduser().resolve()) for p in selected or [] if str(p).strip()]


def pick_folder(title: str = "Select folder") -> str | None:
    """Open a native folder picker.

    On macOS uses osascript (no Dock icon, no Tk window-server registration).
    Falls back to tkinter on other platforms.
    """
    if sys.platform == "darwin":
        result = _osascript(
            f'POSIX path of (choose folder with prompt "{title}")'
        )
        if result is None:
            return None  # user cancelled
        return str(Path(result.strip()).expanduser().resolve())

    # Non-macOS fallback
    selected = _tkinter_pick_folder(title)
    if not selected:
        return None
    return str(Path(selected).expanduser().resolve())


def pick_file(
    title: str = "Select media file",
    filetypes: list[tuple[str, str]] | None = None,
) -> str | None:
    """Open a native single-file picker.

    On macOS uses osascript (no Dock icon, no Tk window-server registration).
    Falls back to tkinter on other platforms.
    """
    if sys.platform == "darwin":
        # Build AppleScript file-type list from the first filetypes entry extensions
        ext_set: list[str] = []
        for _, pattern in (filetypes or [("Video files", "*.mov *.mp4 *.mxf *.avi *.r3d *.mts *.m2t *.m2ts *.mkv *.m4v")]):
            for pat in pattern.split():
                ext = pat.lstrip("*").lstrip(".").lower()
                if ext and ext not in ext_set:
                    ext_set.append(ext)

        if ext_set:
            ext_list = ", ".join(f'"{e}"' for e in ext_set)
            script = f'POSIX path of (choose file of type {{{ext_list}}} with prompt "{title}")'
        else:
            script = f'POSIX path of (choose file with prompt "{title}")'

        result = _osascript(script)
        if result is None:
            return None  # user cancelled
        return str(Path(result.strip()).expanduser().resolve())

    # Non-macOS fallback
    selected = _tkinter_pick_file(title, filetypes)
    if not selected:
        return None
    return str(Path(selected).expanduser().resolve())


def pick_files(
    title: str = "Select media files",
    filetypes: list[tuple[str, str]] | None = None,
) -> list[str]:
    """Open a native multi-file picker and return resolved absolute paths."""
    if sys.platform == "darwin":
        ext_set: list[str] = []
        for _, pattern in (filetypes or [("Video files", "*.mov *.mp4 *.mxf *.avi *.r3d *.mts *.m2t *.m2ts *.mkv *.m4v")]):
            for pat in pattern.split():
                ext = pat.lstrip("*").lstrip(".").lower()
                if ext and ext not in ext_set:
                    ext_set.append(ext)

        if ext_set:
            ext_list = ", ".join(f'"{e}"' for e in ext_set)
            script = (
                'set chosenFiles to choose file of type {'
                + ext_list
                + f'}} with prompt "{title}" with multiple selections allowed\n'
                'set oldTIDs to AppleScript\'s text item delimiters\n'
                'set AppleScript\'s text item delimiters to linefeed\n'
                'set outText to (POSIX path of chosenFiles) as text\n'
                'set AppleScript\'s text item delimiters to oldTIDs\n'
                'return outText'
            )
        else:
            script = (
                f'set chosenFiles to choose file with prompt "{title}" with multiple selections allowed\n'
                'set oldTIDs to AppleScript\'s text item delimiters\n'
                'set AppleScript\'s text item delimiters to linefeed\n'
                'set outText to (POSIX path of chosenFiles) as text\n'
                'set AppleScript\'s text item delimiters to oldTIDs\n'
                'return outText'
            )

        result = _osascript(script)
        if result is None:
            return []
        return [
            str(Path(line.strip()).expanduser().resolve())
            for line in result.splitlines()
            if line.strip()
        ]

    return _tkinter_pick_files(title, filetypes)
