#!/usr/bin/env bash
# PostFlowX Native Helper — macOS Installer
# Double-click this file in Finder (or run it in Terminal) to install.
# The installer will ask for your PostFlowX Extension ID if not pre-filled.
set -euo pipefail

HOST_NAME="com.postflowx.companion"
# Pre-filled by the PostFlowX extension when downloaded from the panel.
# Replace PASTE_YOUR_EXTENSION_ID_HERE with your actual ID if running manually.
EXTENSION_ID="PASTE_YOUR_EXTENSION_ID_HERE"

CHROME_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)
INSTALL_DIR="$HOME/Library/Application Support/PostFlowX/Helper"
WRAPPER="$INSTALL_DIR/postflowx-helper"
MANIFEST_SRC="$INSTALL_DIR/${HOST_NAME}.json"

# ── Validate extension ID ────────────────────────────────────────────────────
if [[ -z "$EXTENSION_ID" || "$EXTENSION_ID" == "PASTE_YOUR_EXTENSION_ID_HERE" ]]; then
  echo ""
  echo "Enter your PostFlowX Extension ID (32 lowercase letters, e.g. abcdefghijklmnopabcdefghijklmnop):"
  read -r EXTENSION_ID
fi
if ! [[ "$EXTENSION_ID" =~ ^[a-z]{32}$ ]]; then
  echo "ERROR: Extension ID must be exactly 32 lowercase letters. Got: '$EXTENSION_ID'" >&2
  exit 1
fi

# ── Find Python 3.10+ ────────────────────────────────────────────────────────
PYTHON=""
for cmd in python3 python3.12 python3.11 python3.10; do
  if command -v "$cmd" &>/dev/null; then
    ver=$("$cmd" -c "import sys; print('%d%d' % sys.version_info[:2])" 2>/dev/null || echo "0")
    if (( ver >= 310 )); then
      PYTHON="$cmd"
      break
    fi
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "ERROR: Python 3.10 or later is required. Install it from https://python.org and re-run." >&2
  exit 1
fi
echo "Using Python: $PYTHON ($("$PYTHON" --version))"

# ── Install postflowx-companion package ─────────────────────────────────────
echo "Installing postflowx-companion..."
"$PYTHON" -m pip install --quiet --upgrade postflowx-companion

# ── Create wrapper script ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cat > "$WRAPPER" <<WRAPPER_EOF
#!/usr/bin/env bash
exec "$PYTHON" -m postflowx_companion.app --mode native-host "\$@"
WRAPPER_EOF
chmod +x "$WRAPPER"
echo "Wrapper created: $WRAPPER"

# ── Write manifest JSON ───────────────────────────────────────────────────────
cat > "$MANIFEST_SRC" <<MANIFEST_EOF
{
  "name": "${HOST_NAME}",
  "description": "PostFlowX Native Helper — AAF export and media tools",
  "path": "${WRAPPER}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
MANIFEST_EOF
echo "Manifest written: $MANIFEST_SRC"

# ── Register manifest in Chrome NativeMessagingHosts directories ──────────────
REGISTERED=0
for dir in "${CHROME_DIRS[@]}"; do
  if [[ -d "$(dirname "$dir")" ]]; then
    mkdir -p "$dir"
    cp "$MANIFEST_SRC" "$dir/${HOST_NAME}.json"
    echo "Registered: $dir/${HOST_NAME}.json"
    REGISTERED=1
  fi
done

if (( REGISTERED == 0 )); then
  echo ""
  echo "WARNING: No Chrome profile directories found. Manifest was written to:"
  echo "  $MANIFEST_SRC"
  echo "Copy it manually to:"
  echo "  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
fi

echo ""
echo "Installation complete!"
echo "  Host:         $HOST_NAME"
echo "  Extension ID: $EXTENSION_ID"
echo ""
echo "Next steps:"
echo "  1. Quit and relaunch Chrome (Cmd+Q, then reopen)."
echo "  2. Open PostFlowX and click 'Re-check Helper' in the AAF panel."
