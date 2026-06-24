# Resolve Engine easy setup

This build is designed for non-technical users.

## What changed

- Settings > Resolve Engine has Easy Mode.
- `Unknown action` and old-helper errors now become Simple Mode compatibility messages instead of a dead-end red failure.
- A double-click macOS installer is included at the root of the PostFlowX folder: `Install_PostFlowX_Helper.command`.
- The installer auto-detects the Chrome extension ID from Chrome Preferences and writes the native messaging manifest.
- The installer uses the user Library folder and does not require sudo/admin by default.
- If Resolve Engine is unavailable, PostFlowX IMF Validation continues without Resolve-assisted checks.

## Non-technical user flow

1. Double-click `Install_PostFlowX_Helper.command`.
2. Wait for `Installation complete`.
3. Reload PostFlowX in `chrome://extensions`.
4. Open Settings > Resolve Engine.
5. Click `Run Easy Check`.

## Important

Resolve Engine is optional. It is only a secondary playback/decode/conform confidence check. Structural IMF validation, label checks, BWAV/ADM parsing, and normal PostFlowX report generation should not be blocked by Resolve.
