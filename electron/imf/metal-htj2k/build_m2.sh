#!/usr/bin/env bash
# Build the M2 full-frame decode harness (arm64 ObjC++; MSL compiled at runtime).
set -euo pipefail
cd "$(dirname "$0")"
clang++ -std=c++17 -fobjc-arc -O2 -arch arm64 -mmacosx-version-min=13.0 \
  -I/opt/homebrew/include/openjph \
  m2_frame_decode.mm \
  -L/opt/homebrew/lib -lopenjph \
  -framework Metal -framework Foundation \
  -o m2_frame_decode
echo "built ./m2_frame_decode"
