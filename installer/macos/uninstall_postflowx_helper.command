#!/usr/bin/env bash
# PostFlowX Native Helper — macOS Uninstaller
set -euo pipefail

HOST_NAME="com.postflowx.companion"
INSTALL_DIR="$HOME/Library/Application Support/PostFlowX/Helper"

CHROME_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

echo "Removing PostFlowX Native Helper manifests..."
for dir in "${CHROME_DIRS[@]}"; do
  f="$dir/${HOST_NAME}.json"
  if [[ -f "$f" ]]; then
    rm -f "$f"
    echo "  Removed: $f"
  fi
done

echo "Removing helper files..."
rm -f "$INSTALL_DIR/postflowx-helper"
rm -f "$INSTALL_DIR/${HOST_NAME}.json"
if [[ -d "$INSTALL_DIR" ]]; then
  rmdir --ignore-fail-on-non-empty "$INSTALL_DIR" 2>/dev/null || true
fi

echo ""
echo "Uninstall complete. Quit and relaunch Chrome to apply."
