#!/usr/bin/env bash
# Build the packaged, self-contained Metal HTJ2K helper for the app.
# Output: electron/native/pfx_htj2k_metal/  (binary + bundled libopenjph + .metal)
# The binary is arm64, deploy target 13.0, and has NO /opt/homebrew dependency
# (libopenjph is bundled and rpath-fixed to @executable_path) so it runs from a
# Finder-launched .app that has no Homebrew on PATH.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../native/pfx_htj2k_metal

DYLIB_SRC=/opt/homebrew/opt/openjph/lib/libopenjph.0.26.0.dylib
DYLIB_NAME=libopenjph.0.26.dylib          # install name the linker records
DYLIB_INSTALL=/opt/homebrew/opt/openjph/lib/$DYLIB_NAME

# Preflight: this optional, default-OFF feature needs Homebrew openjph to build.
# If it's absent (e.g. CI or a machine without brew openjph), SKIP gracefully so
# the overall app build (build:mac / build:mac-dir) still succeeds. Runtime is
# unaffected: with no helper the backend availability probe reports false and IMF
# playback falls back to the existing path. Do NOT abort the parent build.
if [ ! -f "$DYLIB_SRC" ] || [ ! -d /opt/homebrew/include/openjph ]; then
  echo "[build:metal-htj2k] SKIP — Homebrew openjph not found (brew install openjph to enable the optional Metal HTJ2K decoder). App build continues; feature stays unavailable."
  exit 0
fi

mkdir -p "$OUT"

clang++ -std=c++17 -fobjc-arc -O2 -arch arm64 -mmacosx-version-min=13.0 \
  -I/opt/homebrew/include/openjph \
  m2_frame_decode.mm \
  -L/opt/homebrew/lib -lopenjph \
  -framework Metal -framework Foundation \
  -o "$OUT/pfx_htj2k_metal"

# bundle libopenjph next to the binary and rpath-fix
cp -f "$DYLIB_SRC" "$OUT/$DYLIB_NAME"
chmod +w "$OUT/$DYLIB_NAME"
install_name_tool -id "@executable_path/$DYLIB_NAME" "$OUT/$DYLIB_NAME"
install_name_tool -change "$DYLIB_INSTALL" "@executable_path/$DYLIB_NAME" "$OUT/pfx_htj2k_metal"

# install_name_tool invalidates code signatures -> AMFI SIGKILLs the process.
# Re-sign ad-hoc for local runs (electron-builder re-signs during packaging).
codesign --force -s - "$OUT/$DYLIB_NAME" 2>/dev/null || true
codesign --force -s - "$OUT/pfx_htj2k_metal" 2>/dev/null || true

# ship the runtime-compiled MSL kernels alongside the binary (resolved via
# executable-dir by mslPath()).
cp -f cup_decode_mt.metal idwt_color.metal "$OUT/"

echo "== otool -L (must show NO /opt/homebrew) =="
otool -L "$OUT/pfx_htj2k_metal" | sed 's/^/  /'
echo "built $OUT/pfx_htj2k_metal"
