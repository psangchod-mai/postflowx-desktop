#!/usr/bin/env bash
set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$COMPANION_DIR/src/postflowx_companion"

INSTALL_ROOT="/usr/local/lib/postflowx/companion"
INSTALL_SRC="$INSTALL_ROOT/src"
HOST_WRAPPER="/usr/local/lib/postflowx/postflowx-companion-host"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$NM_DIR/com.postflowx.companion.json"

EXTENSION_ID="${PFX_EXTENSION_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:-}"
      shift 2
      ;;
    *)
      echo -e "${RED}Unknown argument:${NC} $1"
      echo "Usage: bash install_dev_macos.sh --extension-id <chrome_extension_id>"
      exit 1
      ;;
  esac
done

infer_extension_id() {
  local legacy_manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.postflowx.host.json"
  if [[ -f "$legacy_manifest" ]]; then
    python3 - <<'PY' "$legacy_manifest" || true
import json, re, sys
path = sys.argv[1]
try:
    data = json.load(open(path, encoding='utf-8'))
    origins = data.get('allowed_origins') or []
    if origins:
        m = re.search(r'chrome-extension://([a-z]{32})/', origins[0])
        if m:
            print(m.group(1))
except Exception:
    pass
PY
  fi
}

if [[ -z "$EXTENSION_ID" ]]; then
  EXTENSION_ID="$(infer_extension_id)"
fi

if [[ -z "$EXTENSION_ID" ]]; then
  echo -e "${RED}Extension ID is required.${NC}"
  echo "Pass it explicitly:"
  echo "  bash companion/scripts/install_dev_macos.sh --extension-id <your_extension_id>"
  echo ""
  echo "You can find it on chrome://extensions while Developer mode is enabled."
  exit 1
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo -e "${RED}Companion source not found:${NC} $SRC_DIR"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo -e "${RED}Python 3 not found.${NC}"
  exit 1
fi

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   PostFlowX Companion macOS Dev Installer   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Using extension ID:${NC} $EXTENSION_ID"
echo -e "${GREEN}Companion source:${NC} $SRC_DIR"

echo ""
echo -e "Installing companion files to ${BLUE}$INSTALL_ROOT${NC} (requires sudo)..."
sudo mkdir -p "$INSTALL_SRC"
sudo rm -rf "$INSTALL_SRC/postflowx_companion"
sudo ditto "$SRC_DIR" "$INSTALL_SRC/postflowx_companion"

sudo tee "$HOST_WRAPPER" >/dev/null <<WRAPPER_EOF
#!/bin/bash
export PYTHONPATH="$INSTALL_SRC\${PYTHONPATH:+:\$PYTHONPATH}"
exec /usr/bin/env python3 -m postflowx_companion.app --mode native-host "\$@"
WRAPPER_EOF
sudo chmod +x "$HOST_WRAPPER"

mkdir -p "$NM_DIR"
cat > "$MANIFEST_PATH" <<MANIFEST_EOF
{
  "name": "com.postflowx.companion",
  "description": "PostFlowX Companion",
  "path": "$HOST_WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
MANIFEST_EOF

for BROWSER in "Google/Chrome Canary" "Chromium"; do
  ALT_DIR="$HOME/Library/Application Support/$BROWSER/NativeMessagingHosts"
  if [[ -d "$(dirname "$ALT_DIR")" ]]; then
    mkdir -p "$ALT_DIR"
    cp "$MANIFEST_PATH" "$ALT_DIR/com.postflowx.companion.json"
  fi
done

echo ""
echo -e "${GREEN}Installed companion wrapper:${NC} $HOST_WRAPPER"
echo -e "${GREEN}Installed native host manifest:${NC} $MANIFEST_PATH"
echo ""
echo "Next steps:"
echo "  1. Reload PostFlowX in chrome://extensions"
echo "  2. Open IMF Validation"
echo "  3. The extension will try com.postflowx.companion first, then fall back to the legacy host if needed"
echo ""
echo -e "${YELLOW}Note:${NC} This is a development installer. It copies the Python source directly."
