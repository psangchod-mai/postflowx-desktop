#!/usr/bin/env bash
# build.sh — Build pfx_helper and copy it to electron/native/
# Usage: ./build.sh [--clean] [--debug]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
NATIVE_DIR="${SCRIPT_DIR}/../../native"

BUILD_TYPE="Release"
CLEAN=0

for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=1 ;;
        --debug) BUILD_TYPE="Debug" ;;
    esac
done

# Check Homebrew dependencies
for pkg in asdcplib openjpeg; do
    if ! brew list "$pkg" &>/dev/null; then
        echo "Installing $pkg via Homebrew..."
        brew install "$pkg"
    fi
done

# Optional: libplacebo for GPU HDR rendering
if brew list libplacebo &>/dev/null; then
    echo "libplacebo found — HDR Metal rendering enabled"
else
    echo "libplacebo not installed — CPU tone-map fallback only"
    echo "  To enable GPU HDR: brew install libplacebo"
fi

if [[ "$CLEAN" -eq 1 && -d "$BUILD_DIR" ]]; then
    echo "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

cmake .. \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DCMAKE_INSTALL_PREFIX="${NATIVE_DIR}" \
    -DHOMEBREW_PREFIX="$(brew --prefix)"

cmake --build . --config "$BUILD_TYPE" -j"$(sysctl -n hw.ncpu)"

BINARY="${BUILD_DIR}/pfx_helper"
if [[ -f "$BINARY" ]]; then
    cp "$BINARY" "${NATIVE_DIR}/pfx_helper"
    # Sign ad-hoc (required for macOS to run unsigned binaries)
    codesign --force --sign - "${NATIVE_DIR}/pfx_helper" 2>/dev/null || true
    echo ""
    echo "✓ pfx_helper built → ${NATIVE_DIR}/pfx_helper"
    "${NATIVE_DIR}/pfx_helper" --version
else
    echo "✗ Build failed — pfx_helper binary not found"
    exit 1
fi
