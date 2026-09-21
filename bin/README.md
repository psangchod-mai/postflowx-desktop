# Bundled native binaries

Place production `ffmpeg` and `ffprobe` (and later vendor helper CLIs) here. They
are copied into `PostFlowX.app/Contents/Resources/bin/` by electron-builder
(`build.extraResources`) and are preferred over Homebrew/PATH by:

- companion: `proxy_service._resource_bin()` → `_find_ffmpeg` / `_find_ffprobe`
- electron:  `electron/native/ffbins.js` (`process.resourcesPath/bin/<name>`)

Why: a Finder/Dock-launched app inherits a stripped PATH with **no** `/opt/homebrew`,
so production must not rely on a dev machine's Homebrew install (Dev Brief P0#2).

## Requirements
- macOS arm64 (universal2 if Intel support is needed)
- `chmod +x ffmpeg ffprobe`
- Must be code-signed + notarized with the rest of the app (Dev Brief P0#5)
- An ffmpeg build with the **exr** encoder (the VFX Pull EXR pull uses
  `-c:v exr -pix_fmt gbrpf32le -format half|float`)

## Override for dev
`PFX_FFMPEG_BIN` / `PFX_FFPROBE_BIN` env vars take priority over everything.
