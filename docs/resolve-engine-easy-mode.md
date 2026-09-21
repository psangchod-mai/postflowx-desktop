# Resolve Engine Easy Mode Fix

This build is designed for non-technical users.

## What changed

- Standard IMF Validation no longer depends on DaVinci Resolve.
- If the installed Native Helper is old and does not understand Resolve Engine actions, PostFlowX no longer shows a red `Unknown action` failure.
- Resolve settings now show an Easy Mode card with two clear choices:
  - `Use Simple Mode` — keep Resolve automation off and continue validating IMF packages in PostFlowX.
  - `Install / Update Helper` — download the helper installer only when automatic Resolve-assisted background jobs are needed.
- `Run Easy Check` replaces the confusing `Test Engine` wording.
- `Start Background` is treated as an advanced option. If it cannot run, the UI falls back to Simple Mode instead of blocking the user.
- Status messages are partner/operator friendly: `Simple Mode active`, `Resolve: Optional`, or `Resolve: Connected`.

## Non-technical user flow

1. Reload the extension.
2. Open PostFlowX > Settings > Resolve Engine.
3. Click `Use Simple Mode`.
4. Continue using IMF Validation normally.

Only use `Install / Update Helper` if the workstation really needs Resolve-assisted background automation.

## Important note

Chrome extensions cannot run DaVinci Resolve directly without the local Native Helper. Therefore Simple Mode is the safe default. Background Resolve automation remains optional and requires the helper to be installed or updated.
