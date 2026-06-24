// companion/native/common/media_types.h
// Shared types and enums for the C++ native helper.
#pragma once
#include <string>
#include <vector>
#include <memory>

namespace pfx {

// Backend keys — must match media_types.py Backend class
struct BackendKey {
    static constexpr const char* STANDARD_MEDIA    = "standard_media";
    static constexpr const char* PRORES_NATIVE     = "prores_native";
    static constexpr const char* PRORES_RAW_NATIVE = "prores_raw_native";
    static constexpr const char* BRAW_SDK          = "braw_sdk";
    static constexpr const char* R3D_SDK           = "r3d_sdk";
    static constexpr const char* ARRI_SDK          = "arri_sdk";
    static constexpr const char* ARRI_TOOL_BRIDGE  = "arri_tool_bridge";
};

struct BackendStatus {
    static constexpr const char* READY          = "ready";
    static constexpr const char* UNAVAILABLE    = "unavailable";
    static constexpr const char* SDK_MISSING    = "sdk_missing";
    static constexpr const char* PREVIEW_ONLY   = "preview_only";
    static constexpr const char* METADATA_ONLY  = "metadata_only";
    static constexpr const char* NOT_INSTALLED  = "not_installed";
};

struct DecodeQuality {
    static constexpr const char* FULL    = "full";
    static constexpr const char* HALF    = "half";
    static constexpr const char* QUARTER = "quarter";
};

// Media file metadata (returned from backend get_metadata)
struct MediaMetadata {
    std::string fileType;
    std::string codec;
    int         width         = 0;
    int         height        = 0;
    double      fps           = 0.0;
    int         durationFrames = 0;
    double      durationSec   = 0.0;
    std::string timecodeStart;
    std::string clipName;
    std::string camera;
    std::string colorSpace;
    std::string colorTransfer;
    std::vector<std::string> decodeModes;
};

// Preview frame result
struct PreviewFrame {
    std::string previewImagePath;
    std::string dataUrl;         // base64 data URL (only if small)
    int         width  = 0;
    int         height = 0;
    int         frameIndex = 0;
    std::string timecode;
    std::string backend;
    bool        cacheHit = false;
};

// Backend capabilities
struct BackendCapabilities {
    bool supportsMetadata            = false;
    bool supportsStillFrameDecode    = false;
    bool supportsPlayback            = false;
    bool supportsHalfRes             = false;
    bool supportsQuarterRes          = false;
    bool supportsHardwareAcceleration = false;
};

}  // namespace pfx
