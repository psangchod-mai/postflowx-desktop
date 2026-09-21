#!/usr/bin/env bash
# Build the PostFlowX RED R3D decode helper (Dev Brief P1#4).
#
# The R3D SDK is NOT vendored in this repo (license: do not redistribute the
# static lib / headers). Point R3DSDK_DIR at an extracted SDK, e.g.:
#   R3DSDK_DIR="$HOME/Documents/Cowork/DEV/R3DSDKv9_2_1" ./build.sh
#
# Output:
#   electron/native/pfx_r3d_decode            (the helper binary)
#   electron/native/r3d_libs/REDR3D.dylib …   (redistributable dylibs, bundled
#                                               side-by-side; RED *permits* shipping
#                                               these — unlike the static lib/headers)
#
# The helper passes its own dir's ../r3d_libs (resolved at runtime) to
# InitializeSdk via PFX_R3DSDK_LIBDIR set by the Python backend, OR you can copy
# the dylibs next to the binary. Default: dylibs in r3d_libs/, backend sets env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$HERE/.." && pwd)"           # electron/native
R3DSDK_DIR="${R3DSDK_DIR:-$HOME/Documents/Cowork/DEV/R3DSDKv9_2_1}"

INC="$R3DSDK_DIR/Include"
LIB="$R3DSDK_DIR/Lib/mac64/libR3DSDK-libcpp.a"
REDIST="$R3DSDK_DIR/Redistributable/mac"

[ -d "$INC" ]    || { echo "ERROR: headers not found at $INC (set R3DSDK_DIR)"; exit 1; }
[ -f "$LIB" ]    || { echo "ERROR: static lib not found at $LIB"; exit 1; }
[ -d "$REDIST" ] || { echo "ERROR: redistributable dylibs not found at $REDIST"; exit 1; }

OUT="$NATIVE_DIR/pfx_r3d_decode"
LIBS_OUT="$NATIVE_DIR/r3d_libs"

echo "[r3d] compiling (arm64) against SDK at $R3DSDK_DIR"
# arm64-only by default (this project ships arm64; universal Swift build is known
# to fail on x86_64 here — see memory postflowx-arm64-build). The SDK static lib
# and dylibs are universal, so a universal C++ build is possible later if needed.
clang++ -std=c++17 -O2 -arch arm64 \
  -mmacosx-version-min=11.0 \
  -I"$INC" \
  "$HERE/pfx_r3d_decode.cpp" \
  "$LIB" \
  -framework Foundation -framework CoreFoundation -framework CoreServices \
  -framework Metal -framework IOKit \
  -o "$OUT"
chmod +x "$OUT"

echo "[r3d] staging redistributable dylibs → $LIBS_OUT"
mkdir -p "$LIBS_OUT"
cp -f "$REDIST"/*.dylib "$LIBS_OUT/"

echo "[r3d] done:"
echo "  binary : $OUT"
echo "  dylibs : $LIBS_OUT"
ls -1 "$LIBS_OUT"
