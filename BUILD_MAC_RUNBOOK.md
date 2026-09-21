# PostFlowX — macOS Build & Sign Runbook (Mac terminal)

The Cowork nightly task edits/verifies source and audits, but **cannot** build the macOS app
(no Xcode/swiftc/electron-builder/signing in its sandbox). Run these on your Mac after a nightly
session lands source changes. Working dir: `/Users/psangchod/Documents/PostFlowX_2.5/PostFlowX_Desktop`.

## Prerequisites (one-time)
- Xcode Command Line Tools: `xcode-select --install` (provides `swiftc`, `lipo`).
- Node deps installed: `npm install`.
- For a *signed/notarized* release: an Apple **Developer ID Application** certificate in your login keychain,
  plus an app-specific password / notarytool profile.

## A. Verify first (matches what Cowork ran — confirm it's green)
```bash
cd /Users/psangchod/Documents/PostFlowX_2.5/PostFlowX_Desktop
npm run test:node && npm run test:js && (cd companion && python3 -m pytest -q)
```

## B. Build the native bridge + renderer
```bash
npm run build:avf        # swiftc → electron/native/avf_bridge (universal)
npm run build:renderer   # node build-renderer.js --target desktop
```

## C. Package the app
- **Unsigned, for local testing** (fastest):
  ```bash
  npm run build:mac-dir            # electron-builder --mac dir, identity=null, notarize=false
  # output: dist/mac-arm64/PostFlowX.app
  ```
- **Unsigned universal DMG**:
  ```bash
  npm run dist:mac:unsigned
  ```
- **Netflix signed release**: use Rocket CI rather than exporting credentials in a local shell. `.netflix/rocket.yml` selects `macos_arm64_aws && nf.app:sct_macbuilders`; `.netflix/netflix.ci` uses `update-keychain`, the exact `Developer ID Application: Netflix, Inc. (EZ4M4LKSQP)` identity, and Jenkins-bound `NOTARIZE_APPLE_ID` / `NOTARIZE_APP_PASSWORD` credentials. Signing and notarization run only on `main`.

  The CI gate runs `npm run build-verify`, uses electron-builder for the signed/notarized universal app, then separately signs, submits, staples, and Gatekeeper-checks the final DMG. It mounts that DMG read-only and verifies the Applications shortcut, universal executable, and byte-identical packaged `app.asar` before reporting the artifact ready. Credentials are never stored in this repository.

## D. Sanity-check the result
```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/PostFlowX.app" || echo "unsigned (expected for build:mac-dir)"
spctl -a -vvv "dist/mac-arm64/PostFlowX.app" 2>&1 | head    # Gatekeeper assessment (signed builds)
```

---

## Paste-ready prompt for Claude Code (Sonnet / medium)
Launch in this folder and let Claude Code drive the build:
```bash
cd /Users/psangchod/Documents/PostFlowX_2.5/PostFlowX_Desktop
claude --model sonnet --effort medium
```
Then paste:

> Build the PostFlowX macOS app from this source tree. Steps:
> 1) Run verify: `npm run test:node && npm run test:js && (cd companion && python3 -m pytest -q)`. If anything fails, stop and show me the failure — do not build on red.
> 2) `npm run build:avf` then `npm run build:renderer`.
> 3) `npm run build:mac-dir` for an unsigned local build (or ask me first if I want the signed `npm run build:mac`).
> 4) Verify the output with `codesign --verify` and `spctl -a -vvv` on `dist/mac-arm64/PostFlowX.app` and summarize: did it build, is it signed, any warnings, and the app path.
> Do not edit source files — this is a build-only run. Read `PostFlowX_Morning_Report.md` first to see what changed last night.

For unattended/scheduled use add `-p "<prompt>" --permission-mode dontAsk` and set `ANTHROPIC_API_KEY` in the environment (subscription login does not drive headless runs).
