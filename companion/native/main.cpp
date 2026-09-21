// companion/native/main.cpp
// PostFlowX C++ native helper — Phase 1 scaffold.
//
// Phase 1: Python companion (postflowx_companion) handles all media commands.
// This C++ binary will replace it in Phase 3+ for BRAW/R3D SDK access.
//
// To build (macOS example):
//   clang++ -std=c++17 -O2 main.cpp messaging/native_messaging_io.cpp \
//     -o postflowx_native_helper
//
// NOTE: Full implementation pending Phase 3.
// The Python companion (api.py) is the active implementation for Phase 1.

#include <iostream>
#include <string>

int main(int argc, char* argv[]) {
    // Phase 1: Not the active binary.
    // Python companion handles all NM messages via postflowx-companion.
    // This scaffold exists to define the architecture for Phase 3.
    std::cerr << "[pfx-native] Phase 1 scaffold — Python companion is active\n";
    return 1;
}
