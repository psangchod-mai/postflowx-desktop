#!/bin/bash
# PostFlowX Native Messaging Host Installer
# Run once: bash install_host.sh
# Requires: macOS, Python 3 (pre-installed), ffmpeg (brew install ffmpeg)

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   PostFlowX Native Host Installer        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

EXTENSION_ID="${PFX_EXTENSION_ID:-}"

infer_extension_id() {
  local companion_manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.postflowx.companion.json"
  local legacy_manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.postflowx.host.json"
  python3 - "$companion_manifest" "$legacy_manifest" <<'PY' || true
import json
import re
import sys

for path in sys.argv[1:]:
    try:
        data = json.load(open(path, encoding='utf-8'))
    except Exception:
        continue
    for origin in data.get('allowed_origins') or []:
        m = re.search(r'chrome-extension://([a-z]{32})/', origin)
        if m:
            print(m.group(1))
            raise SystemExit(0)
PY
}

if [ -z "$EXTENSION_ID" ]; then
  EXTENSION_ID="$(infer_extension_id)"
fi

if [ -z "$EXTENSION_ID" ]; then
  echo -e "${RED}✗ Extension ID not found.${NC}"
  echo "  Launch PostFlowX once or run with:"
  echo "  PFX_EXTENSION_ID=<chrome_extension_id> bash install_host.sh"
  exit 1
fi
echo -e "${GREEN}✓ Extension ID: $EXTENSION_ID${NC}"

# ── Check Python 3 ───────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo -e "${RED}✗ Python 3 not found. Install Xcode Command Line Tools:${NC}"
  echo "  xcode-select --install"
  exit 1
fi
echo -e "${GREEN}✓ Python 3: $(python3 --version)${NC}"

# ── Check ffmpeg ─────────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  echo -e "${YELLOW}⚠  ffmpeg not found.${NC}"
  echo "  Install with Homebrew: brew install ffmpeg"
  echo "  (The host will install anyway; ffmpeg needed at runtime)"
else
  echo -e "${GREEN}✓ ffmpeg: $(ffmpeg -version 2>&1 | head -1)${NC}"
fi

# ── Determine script directory ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PY="$SCRIPT_DIR/pfx_host.py"

if [ ! -f "$HOST_PY" ]; then
  echo -e "${RED}✗ pfx_host.py not found in $SCRIPT_DIR${NC}"
  exit 1
fi

# ── Install host binary ───────────────────────────────────────────────────────
INSTALL_DIR="/usr/local/lib/postflowx"
echo ""
echo -e "Installing host to ${BLUE}$INSTALL_DIR${NC} (requires sudo)..."
sudo mkdir -p "$INSTALL_DIR"
sudo cp "$HOST_PY" "$INSTALL_DIR/pfx_host.py"
sudo chmod +x "$INSTALL_DIR/pfx_host.py"

# Add Python shebang wrapper so Chrome can launch it directly
WRAPPER="$INSTALL_DIR/pfx_host"
sudo tee "$WRAPPER" > /dev/null <<'WRAPPER_EOF'
#!/bin/bash
exec /usr/bin/env python3 /usr/local/lib/postflowx/pfx_host.py "$@"
WRAPPER_EOF
sudo chmod +x "$WRAPPER"
echo -e "${GREEN}✓ Host installed to $INSTALL_DIR${NC}"

# ── Install NM manifest for Chrome ───────────────────────────────────────────
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$NM_DIR"

# Write manifest pointing to wrapper script
cat > "$NM_DIR/com.postflowx.companion.json" <<MANIFEST_EOF
{
  "name": "com.postflowx.companion",
  "description": "PostFlowX Companion",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
MANIFEST_EOF
echo -e "${GREEN}✓ Chrome NM manifest installed to $NM_DIR${NC}"

# ── Install system-wide so all users on this Mac work without re-running setup ─
SYS_NM="/Library/Google/Chrome/NativeMessagingHosts"
sudo mkdir -p "$SYS_NM" && sudo cp "$NM_DIR/com.postflowx.companion.json" "$SYS_NM/" \
  && echo -e "${GREEN}✓ System-wide manifest installed (all users)${NC}" \
  || echo -e "${YELLOW}⚠  Could not install system-wide manifest (non-fatal)${NC}"

# ── Also install for Chrome Canary / Chromium if present ─────────────────────
for BROWSER in "Google/Chrome Canary" "Chromium" "Google/Chrome Beta" "Google/Chrome Dev"; do
  ALT_DIR="$HOME/Library/Application Support/$BROWSER/NativeMessagingHosts"
  if [ -d "$(dirname "$ALT_DIR")" ]; then
    mkdir -p "$ALT_DIR"
    cp "$NM_DIR/com.postflowx.companion.json" "$ALT_DIR/"
    echo -e "${GREEN}✓ Also installed for $BROWSER${NC}"
  fi
  SYS_ALT="/Library/Application Support/$BROWSER/NativeMessagingHosts"
  sudo mkdir -p "$SYS_ALT" && sudo cp "$NM_DIR/com.postflowx.companion.json" "$SYS_ALT/" 2>/dev/null || true
done

# ── Verify ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Installation complete!                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. Reload PostFlowX in chrome://extensions"
echo "  2. Drop a ProRes .mov file into the V2 (Shots) bin"
echo "  3. PostFlowX will auto-connect and stream it via H.264"
echo ""
echo -e "${YELLOW}If ffmpeg is missing:${NC}  brew install ffmpeg"
echo ""
