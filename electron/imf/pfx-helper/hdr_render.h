#pragma once
// hdr_render.h — HDR tone-mapping and Dolby Vision rendering via libplacebo (Metal)

#include "j2k_decode.h"

#include <cstdint>
#include <string>
#include <vector>

// Display mode requested by the caller
enum class DisplayMode { SDR, HDR, RAW };

struct RenderResult {
    bool        ok             = false;
    bool        toneMapApplied = false;
    std::string dvProfile;      // e.g. "P5", "P8", or empty
    std::string error;
};

// Render a decoded frame through the HDR/DV pipeline.
//
// In SDR mode: tone-maps PQ/HLG → BT.709 via libplacebo's Reinhard/Hable/BT.2408 operators.
// In HDR mode: converts to display-referred PQ for EDR displays; no clipping.
// In RAW mode: clamps [0,1] float to 8-bit without any colour management.
// DV RPU bytes (if non-empty) are applied to the BL frame before tone-mapping.
//
// The result is written to outPath as PNG or JPEG depending on the extension.
RenderResult hdr_render(
    DecodedFrame&              frame,
    const std::vector<uint8_t>& dvRpu,
    DisplayMode                 mode,
    bool                        isHDR,
    const std::string&          outPath,
    uint32_t                    outputWidth = 1920,
    int                         jpegQuality = 85
);

// Initialise the libplacebo Metal GPU context.
// Must be called once before the first hdr_render(); thread-safe.
bool hdr_init_gpu();

// Release the libplacebo context.  Call before process exit.
void hdr_shutdown_gpu();
