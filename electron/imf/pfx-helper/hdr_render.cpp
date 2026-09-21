// hdr_render.cpp — HDR tone-mapping via libplacebo (Metal) with CPU fallback

#include "hdr_render.h"

#include <algorithm>
#include <cmath>

// ── libplacebo path ───────────────────────────────────────────────────────────

#ifdef HAVE_LIBPLACEBO
#include <libplacebo/renderer.h>
#include <libplacebo/gpu.h>
#include <libplacebo/shaders/colorspace.h>
#include <libplacebo/utils/upload.h>

// Metal-backed GPU context (via MoltenVK / libplacebo Metal backend)
// libplacebo's Metal backend is available in libplacebo ≥5.264.
#if PL_API_VER >= 264
#include <libplacebo/metal/metal.h>
#endif

static pl_log      _pl_log   = nullptr;
static pl_gpu      _pl_gpu   = nullptr;
static pl_renderer _pl_rend  = nullptr;
static bool        _gpu_init = false;

bool hdr_init_gpu() {
    if (_gpu_init) return true;

    _pl_log = pl_log_create(PL_API_VER, pl_log_params(
        .log_level = PL_LOG_WARN,
        .log_cb    = nullptr,
    ));
    if (!_pl_log) return false;

#if PL_API_VER >= 264
    _pl_gpu = pl_metal_create(_pl_log, nullptr);
#else
    // Older libplacebo: fall back to CPU (no GPU acceleration)
    _pl_gpu = nullptr;
#endif

    if (_pl_gpu) {
        _pl_rend = pl_renderer_create(_pl_log, _pl_gpu);
    }
    _gpu_init = true;
    return true;
}

void hdr_shutdown_gpu() {
    if (_pl_rend) { pl_renderer_destroy(&_pl_rend); _pl_rend = nullptr; }
    if (_pl_gpu)  { pl_gpu_destroy(&_pl_gpu);        _pl_gpu  = nullptr; }
    if (_pl_log)  { pl_log_destroy(&_pl_log);         _pl_log  = nullptr; }
    _gpu_init = false;
}

// ── GPU-accelerated tone-map ───────────────────────────────────────────────────

static RenderResult _render_placebo(DecodedFrame& frame, DisplayMode mode,
                                     bool isHDR, const std::string& outPath,
                                     uint32_t outputWidth, int quality)
{
    RenderResult result;
    if (!_pl_gpu || !_pl_rend) {
        result.error = "libplacebo GPU not initialised";
        return result;
    }

    // Upload source texture
    pl_tex src_tex = pl_tex_create(_pl_gpu, pl_tex_params(
        .w           = (int)frame.width,
        .h           = (int)frame.height,
        .format      = pl_find_fmt(_pl_gpu, PL_FMT_FLOAT, 4, 0, 32, PL_FMT_CAP_SAMPLEABLE),
        .sampleable  = true,
        .initial_data = frame.rgba.data(),
    ));

    uint32_t dstW = outputWidth;
    uint32_t dstH = frame.height * dstW / frame.width;

    pl_tex dst_tex = pl_tex_create(_pl_gpu, pl_tex_params(
        .w          = (int)dstW,
        .h          = (int)dstH,
        .format     = pl_find_fmt(_pl_gpu, PL_FMT_FLOAT, 4, 0, 32, PL_FMT_CAP_RENDERABLE),
        .renderable = true,
        .blit_dst   = true,
    ));

    if (!src_tex || !dst_tex) {
        if (src_tex) pl_tex_destroy(_pl_gpu, &src_tex);
        if (dst_tex) pl_tex_destroy(_pl_gpu, &dst_tex);
        result.error = "pl_tex_create failed";
        return result;
    }

    pl_color_space srcCS = isHDR ? pl_color_space_hdr10 : pl_color_space_srgb;
    pl_color_space dstCS = (mode == DisplayMode::HDR) ? pl_color_space_hdr10 : pl_color_space_srgb;

    struct pl_render_params renderParams = pl_render_default_params;
    if (mode == DisplayMode::SDR && isHDR) {
        renderParams.color_map_params = &pl_color_map_default_params;
    }

    struct pl_frame srcFrame = {
        .num_planes = 1,
        .planes     = {{ .texture = src_tex, .components = 4, .component_mapping = {0,1,2,3} }},
        .color      = srcCS,
    };
    struct pl_frame dstFrame = {
        .num_planes = 1,
        .planes     = {{ .texture = dst_tex, .components = 4, .component_mapping = {0,1,2,3} }},
        .color      = dstCS,
    };

    bool renderOk = pl_render_image(_pl_rend, &srcFrame, &dstFrame, &renderParams);

    // Download result
    std::vector<float> outPixels(static_cast<size_t>(dstW) * dstH * 4);
    bool dlOk = renderOk && pl_tex_download(_pl_gpu, pl_tex_transfer_params(
        .tex  = dst_tex,
        .ptr  = outPixels.data(),
        .stride_w = dstW,
    ));

    pl_tex_destroy(_pl_gpu, &src_tex);
    pl_tex_destroy(_pl_gpu, &dst_tex);

    if (!dlOk) {
        result.error = "pl_render_image or download failed";
        return result;
    }

    // Write output
    DecodedFrame out;
    out.width = dstW; out.height = dstH; out.rgba = std::move(outPixels); out.components = 4;
    bool writeOk = outPath.ends_with(".png") ? write_png(out, outPath) : write_jpeg(out, outPath, quality);
    if (!writeOk) { result.error = "write output failed"; return result; }

    result.ok             = true;
    result.toneMapApplied = (mode == DisplayMode::SDR && isHDR);
    return result;
}

#else // !HAVE_LIBPLACEBO

bool hdr_init_gpu()    { return false; }
void hdr_shutdown_gpu() {}

#endif // HAVE_LIBPLACEBO

// ── CPU tone-map fallback ─────────────────────────────────────────────────────
// Reinhard tone-mapper in BT.2020 PQ → BT.709 path (CPU, no GPU required).

static float _pq_eotf(float n) {
    // SMPTE ST 2084 EOTF  (n is normalised PQ code in [0,1])
    const float m1 = 0.1593017578125f;
    const float m2 = 78.84375f;
    const float c1 = 0.8359375f;
    const float c2 = 18.8515625f;
    const float c3 = 18.6875f;
    float xp = std::pow(std::max(n, 0.0f), 1.0f / m2);
    float num = std::max(xp - c1, 0.0f);
    float den = c2 - c3 * xp;
    return std::pow(num / den, 1.0f / m1) * 10000.0f;   // nits
}

static float _bt709_oetf(float lin) {
    lin = std::max(lin, 0.0f);
    if (lin < 0.018f) return lin * 4.5f;
    return 1.099f * std::pow(lin, 0.45f) - 0.099f;
}

// BT.2020 linear → BT.709 linear matrix (Bradford-adapted D65)
static const float _M_2020_709[3][3] = {
    { 1.6604910f, -0.5876411f, -0.0728499f},
    {-0.1245505f,  1.1328999f, -0.0083494f},
    {-0.0181508f, -0.1005789f,  1.1187297f},
};

static void _cpu_tone_map_sdr(DecodedFrame& frame, uint32_t targetWidth) {
    // Reinhard global operator: L_out = L_in / (1 + L_in), mapped from PQ nits
    for (size_t i = 0; i < static_cast<size_t>(frame.width) * frame.height; ++i) {
        float* px = &frame.rgba[i * 4];
        float r = _pq_eotf(px[0]) / 10000.0f;   // [0,1] in display nits
        float g = _pq_eotf(px[1]) / 10000.0f;
        float b = _pq_eotf(px[2]) / 10000.0f;

        // BT.2020 → BT.709
        float r709 = _M_2020_709[0][0]*r + _M_2020_709[0][1]*g + _M_2020_709[0][2]*b;
        float g709 = _M_2020_709[1][0]*r + _M_2020_709[1][1]*g + _M_2020_709[1][2]*b;
        float b709 = _M_2020_709[2][0]*r + _M_2020_709[2][1]*g + _M_2020_709[2][2]*b;

        // Reinhard
        r709 = r709 / (1.0f + r709);
        g709 = g709 / (1.0f + g709);
        b709 = b709 / (1.0f + b709);

        px[0] = _bt709_oetf(r709);
        px[1] = _bt709_oetf(g709);
        px[2] = _bt709_oetf(b709);
    }
}

// ── hdr_render ────────────────────────────────────────────────────────────────

RenderResult hdr_render(DecodedFrame& frame,
                         const std::vector<uint8_t>& dvRpu,
                         DisplayMode mode,
                         bool isHDR,
                         const std::string& outPath,
                         uint32_t outputWidth,
                         int jpegQuality)
{
    RenderResult result;

    if (frame.rgba.empty() || frame.width == 0) {
        result.error = "empty frame";
        return result;
    }

#ifdef HAVE_LIBPLACEBO
    // Try GPU path first
    if (_gpu_init && _pl_gpu) {
        return _render_placebo(frame, mode, isHDR, outPath, outputWidth, jpegQuality);
    }
#endif

    // CPU fallback
    if (mode == DisplayMode::SDR && isHDR) {
        _cpu_tone_map_sdr(frame, outputWidth);
        result.toneMapApplied = true;
    }

    // Scale to output width
    DecodedFrame scaled = (outputWidth > 0 && outputWidth < frame.width)
        ? scale_frame(frame, outputWidth)
        : std::move(frame);

    bool writeOk = outPath.ends_with(".png") ? write_png(scaled, outPath) : write_jpeg(scaled, outPath, jpegQuality);
    if (!writeOk) {
        result.error = "write_png/write_jpeg failed: " + outPath;
        return result;
    }

    result.ok = true;
    return result;
}
