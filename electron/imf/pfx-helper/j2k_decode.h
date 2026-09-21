#pragma once
// j2k_decode.h — OpenJPEG decode pipeline: J2K/HTJ2K codestream → RGBA float pixels

#include <cstdint>
#include <string>
#include <vector>

struct DecodedFrame {
    uint32_t width      = 0;
    uint32_t height     = 0;
    uint32_t bitDepth   = 12;
    uint32_t components = 3;   // 3 = RGB/YCbCr, 4 = RGBA

    // Decoded pixel data: interleaved float RGBA in [0, 1] linear-light.
    // Luma-only (1-component) is expanded to 3-channel grey.
    std::vector<float> rgba;

    std::string error;
};

// Decode a raw J2K codestream (no MXF wrapping) using OpenJPEG.
// Returns false if decoding fails (check result.error).
bool j2k_decode(const uint8_t* data, size_t size, bool isHTJ2K, DecodedFrame& result);

// Write decoded RGBA pixels to a JPEG file (quality 1–100) or PNG file.
bool write_jpeg(const DecodedFrame& frame, const std::string& outPath, int quality = 85);
bool write_png(const DecodedFrame& frame, const std::string& outPath);

// Scale decoded frame to a target width (maintains aspect ratio).
DecodedFrame scale_frame(const DecodedFrame& src, uint32_t targetWidth);
