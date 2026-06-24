#!/bin/bash
set -euo pipefail

# PostFlowX easy native helper installer for macOS.
# This file is safe to double-click. It installs only for the current user.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.postflowx.companion"
DEFAULT_ID="AUTO"
APP_SUPPORT="$HOME/Library/Application Support"
INSTALL_ROOT="$APP_SUPPORT/PostFlowX/Companion"
INSTALL_SRC="$INSTALL_ROOT/src"
WRAPPER_PATH="$INSTALL_ROOT/postflowx-companion-host"
LOG_DIR="$HOME/Library/Logs/PostFlowX"
LOG_FILE="$LOG_DIR/companion-native.log"
NM_CHROME="$APP_SUPPORT/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$NM_CHROME/$HOST_NAME.json"

mkdir -p "$INSTALL_ROOT" "$INSTALL_SRC" "$LOG_DIR" "$NM_CHROME"

infer_extension_id() {
  python3 - <<'PYID' "$MANIFEST_PATH" "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.postflowx.host.json" 2>/dev/null || true
import json, re, sys
for path in sys.argv[1:]:
    try:
        data = json.load(open(path, encoding='utf-8'))
        for origin in data.get('allowed_origins') or []:
            m = re.search(r'chrome-extension://([a-p]{32})/', origin)
            if m:
                print(m.group(1))
                raise SystemExit
    except Exception:
        pass
PYID
}

find_source_dir() {
  local candidates=(
    "$SCRIPT_DIR/companion/src"
    "$SCRIPT_DIR/PostFlowX/companion/src"
    "$HOME/Downloads/PostFlowX/companion/src"
    "$HOME/Downloads/PostFlowX 7/PostFlowX/companion/src"
    "$HOME/Downloads/PostFlowX_easy_resolve/PostFlowX/companion/src"
    "$HOME/Downloads/PostFlowX_resolve_easy_nontech/PostFlowX/companion/src"
    "$HOME/Desktop/PostFlowX/companion/src"
    "$HOME/Documents/PostFlowX/companion/src"
    "$HOME/Movies/PFX/companion/src"
    "$HOME/Library/Application Support/PostFlowX/Companion/src"
    "/usr/local/lib/postflowx/companion/src"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -d "$c/postflowx_companion" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  local found
  found="$(find "$HOME" -maxdepth 8 -type d -name postflowx_companion 2>/dev/null | head -1 || true)"
  if [ -n "$found" ]; then
    printf '%s' "${found%/postflowx_companion}"
    return 0
  fi
  return 1
}

EXTENSION_ID="${PFX_EXTENSION_ID:-}"
if [ -z "$EXTENSION_ID" ] && [ "$DEFAULT_ID" != "AUTO" ] && [ "$DEFAULT_ID" != "AUTO" ]; then
  EXTENSION_ID="$DEFAULT_ID"
fi
if [ -z "$EXTENSION_ID" ]; then
  EXTENSION_ID="$(infer_extension_id | head -1 | tr -d '[:space:]' || true)"
fi
if [ -z "$EXTENSION_ID" ]; then
  if command -v osascript >/dev/null 2>&1; then
    EXTENSION_ID="$(osascript <<OSA 2>/dev/null || true
text returned of (display dialog "Paste your PostFlowX Extension ID.\n\nTip: in PostFlowX Settings, click 'Copy Extension ID'." default answer "" buttons {"Cancel", "Install"} default button "Install")
OSA
)"
  fi
fi
EXTENSION_ID="$(printf '%s' "$EXTENSION_ID" | tr -d '\r\n[:space:]')"

SRC_DIR="$(find_source_dir || true)"

clear || true
echo "PostFlowX Easy Helper Installer"
echo ""
echo "Extension ID: $EXTENSION_ID"
echo "Source:       ${SRC_DIR:-not found yet}"
echo "Install to:   $INSTALL_ROOT"
echo ""

if [ -z "$EXTENSION_ID" ] || ! printf '%s' "$EXTENSION_ID" | grep -Eq '^[a-p]{32}$'; then
  echo "ERROR: Extension ID is missing or invalid."
  echo "Open PostFlowX Settings, click Copy Extension ID, then run this installer again."
  echo ""
  read -p "Press Enter to close."
  exit 1
fi

if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR/postflowx_companion" ]; then
  echo "ERROR: Could not find the PostFlowX companion source."
  echo ""
  echo "Fix: unzip the full PostFlowX package, then run this installer again."
  echo "The unzipped folder must contain: PostFlowX/companion/src/postflowx_companion"
  echo ""
  read -p "Press Enter to close."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: Python 3 is not installed."
  echo "Install Python 3, then run this installer again."
  echo ""
  read -p "Press Enter to close."
  exit 1
fi

PY_OK="$(python3 - <<'PYCHECK' 2>/dev/null || true
import sys
print('1' if sys.version_info >= (3, 10) else '0')
PYCHECK
)"
if [ "$PY_OK" != "1" ]; then
  echo "ERROR: Python 3.10 or newer is required."
  python3 --version || true
  echo ""
  read -p "Press Enter to close."
  exit 1
fi

echo "Step 1/4: Copy helper files..."
rm -rf "$INSTALL_SRC/postflowx_companion"
if command -v ditto >/dev/null 2>&1; then
  ditto "$SRC_DIR/postflowx_companion" "$INSTALL_SRC/postflowx_companion"
else
  cp -R "$SRC_DIR/postflowx_companion" "$INSTALL_SRC/postflowx_companion"
fi

echo "Step 2/4: Write helper launcher..."
cat > "$WRAPPER_PATH" <<WRAPEOF
#!/bin/bash
export PYTHONPATH="$INSTALL_SRC\${PYTHONPATH:+:\$PYTHONPATH}"
export POSTFLOWX_LOG_FILE="$LOG_FILE"
exec /usr/bin/env python3 -m postflowx_companion.app --mode native-host 2>> "$LOG_FILE"
WRAPEOF
chmod +x "$WRAPPER_PATH"

echo "Step 3/4: Register with Chrome..."
cat > "$MANIFEST_PATH" <<MANIFESTEOF
{
  "name": "$HOST_NAME",
  "description": "PostFlowX Companion Native Helper",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
MANIFESTEOF

for BROWSER_DIR in \
  "$APP_SUPPORT/Google/Chrome Canary/NativeMessagingHosts" \
  "$APP_SUPPORT/Google/Chrome Beta/NativeMessagingHosts" \
  "$APP_SUPPORT/Chromium/NativeMessagingHosts"
do
  if [ -d "$(dirname "$BROWSER_DIR")" ]; then
    mkdir -p "$BROWSER_DIR"
    cp "$MANIFEST_PATH" "$BROWSER_DIR/$HOST_NAME.json"
  fi
done

echo "Step 4/4: Quick validation..."
PYTHONPATH="$INSTALL_SRC" python3 - <<'PYVALID'
import postflowx_companion
print('OK: helper package imports')
PYVALID

echo ""
echo "Installation complete."
echo ""
echo "Next steps:"
echo "  1. Quit Chrome completely with Cmd+Q."
echo "  2. Reopen Chrome and PostFlowX."
echo "  3. Go to Settings > Resolve Engine and click Check Setup."
echo ""
echo "Installed files:"
echo "  $MANIFEST_PATH"
echo "  $WRAPPER_PATH"
echo "  $LOG_FILE"
echo ""
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Quit and reopen Chrome, then click Check Setup." with title "PostFlowX Helper installed"' >/dev/null 2>&1 || true
fi
read -p "Press Enter to close."
