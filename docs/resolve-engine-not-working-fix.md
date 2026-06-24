# PostFlowX Resolve Engine fix — unknown native actions

## Problem observed

The Resolve Engine settings panel can detect the Resolve path/version and scripting availability, but `Start Engine` fails with native host errors:

- `Unknown action: resolve.engineStatus`
- `Unknown action: resolve.startEngine`

This means the UI is calling the newer Resolve Engine API, but the installed native companion does not yet expose those actions.

## Fix included

This build adds backward-compatible companion/native actions:

- `resolve.engineStatus` / `resolveEngineStatus`
- `resolve.startEngine` / `resolveStartEngine`
- `resolve.stopEngine` / `resolveStopEngine`
- `resolve.listJobs` / `resolveListJobs`
- `resolve.clearQueue` / `resolveClearQueue`
- `resolve.getLogs` / `resolveGetLogs`
- `resolve.openLogs` / `resolveOpenLogs`

The existing actions are preserved:

- `resolve.detect`
- `resolve.test`
- `resolve.runJob`
- `resolve.jobStatus`
- `resolve.cancelJob`
- `resolve.manualHandoff`

## Files changed

- `companion/src/postflowx_companion/engines/resolve_engine.py`
- `companion/src/postflowx_companion/api.py`
- `companion/src/postflowx_companion/native_host.py`
- `companion/src/postflowx_companion/service_state.py`
- `scripts/modules/native_helper_client.js`
- `scripts/modules/project_setup.js`
- `styles/main.css`
- `companion/tests/test_resolve_engine.py`

## Required install step

Because the error is in the local native companion, reload the Chrome extension alone is not enough. Reinstall/update the companion after unzipping this build:

```bash
cd /path/to/PostFlowX
bash companion/scripts/install_dev_macos.sh --extension-id <your_chrome_extension_id>
```

Then:

1. Reload PostFlowX in `chrome://extensions`.
2. Open Settings > Resolve Engine.
3. Click `Refresh Status` or `Test Engine`.
4. Click `Start Engine`.

## Notes

- `Test Engine` does not launch Resolve. It only detects install/scripting/API status.
- `Start Engine` may launch Resolve in headless/background mode when the workstation supports it.
- If Resolve does not support headless launch on that machine, the companion returns `RESOLVE_HEADLESS_UNAVAILABLE` instead of a fake pass.
- `Stop` only stops a companion-owned Resolve process; it will not kill a user-opened Resolve session.
