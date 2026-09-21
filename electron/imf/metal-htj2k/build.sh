#!/usr/bin/env bash
# Build the standalone ObjC++ HTJ2K block-decode harness.
# CLT-only box: no Xcode, no offline metallib -> MSL is compiled at RUNTIME by
# the harness (newLibraryWithSource:). We only link Metal + Foundation here, and
# libopenjph for the exported scalar reference decoder.
set -euo pipefail
cd "$(dirname "$0")"
clang++ -std=c++17 -fobjc-arc -O2 -arch arm64 -mmacosx-version-min=13.0 \
  -I/opt/homebrew/include/openjph \
  m1_block_decode.mm \
  -L/opt/homebrew/lib -lopenjph \
  -framework Metal -framework Foundation \
  -o m1_block_decode
echo "built ./m1_block_decode"
