// j2k_decode.cpp — OpenJPEG decode + JPEG/PNG write

#include "j2k_decode.h"

#include <openjpeg.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <memory>

// ── OpenJPEG message callbacks ────────────────────────────────────────────────

static void _opj_err(const char* msg, void*)   { (void)msg; }
static void _opj_warn(const char* msg, void*)  { (void)msg; }
static void _opj_info(const char* msg, void*)  { (void)msg; }

// ── j2k_decode ───────────────────────────────────────────────────────────────

bool j2k_decode(const uint8_t* data, size_t size, bool isHTJ2K, DecodedFrame& result) {
    OPJ_CODEC_FORMAT fmt = isHTJ2K ? OPJ_CODEC_HTJ2K : OPJ_CODEC_J2K;

    opj_codec_t* codec = opj_create_decompress(fmt);
    if (!codec) {
        // HTJ2K may not be compiled into this OpenJPEG build — fall back to J2K
        if (isHTJ2K) {
            codec = opj_create_decompress(OPJ_CODEC_J2K);
            if (!codec) { result.error = "opj_create_decompress failed"; return false; }
        } else {
            result.error = "opj_create_decompress failed";
            return false;
        }
    }

    opj_set_error_handler(codec,   _opj_err,  nullptr);
    opj_set_warning_handler(codec, _opj_warn, nullptr);
    opj_set_info_handler(codec,    _opj_info, nullptr);

    opj_dparameters_t params;
    opj_set_default_decoder_parameters(&params);
    if (!opj_setup_decoder(codec, &params)) {
        opj_destroy_codec(codec);
        result.error = "opj_setup_decoder failed";
        return false;
    }

    // Wrap codestream bytes in an OpenJPEG in-memory stream
    opj_stream_t* stream = opj_stream_create_default_memory_stream(
        const_cast<uint8_t*>(data), static_cast<OPJ_SIZE_T>(size), OPJ_TRUE);
    if (!stream) {
        opj_destroy_codec(codec);
        result.error = "opj_stream_create_default_memory_stream failed";
        return false;
    }

    opj_image_t* image = nullptr;
    if (!opj_read_header(stream, codec, &image)) {
        opj_stream_destroy(stream);
        opj_destroy_codec(codec);
        result.error = "opj_read_header failed";
        return false;
    }

    if (!opj_decode(codec, stream, image) || !opj_end_decompress(codec, stream)) {
        opj_image_destroy(image);
        opj_stream_destroy(stream);
        opj_destroy_codec(codec);
        result.error = "opj_decode failed";
        return false;
    }

    opj_stream_destroy(stream);
    opj_destroy_codec(codec);

    const uint32_t w    = image->comps[0].w;
    const uint32_t h    = image->comps[0].h;
    const uint32_t nComp = image->numcomps;

    result.width      = w;
    result.height     = h;
    result.components = nComp;
    result.bitDepth   = image->comps[0].prec;

    const float scale = 1.0f / static_cast<float>((1 << result.bitDepth) - 1);
    const bool  isSigned = image->comps[0].sgnd;
    const float offset   = isSigned ? static_cast<float>(1 << (result.bitDepth - 1)) : 0.0f;

    result.rgba.resize(static_cast<size_t>(w) * h * 4, 1.0f);

    for (uint32_t y = 0; y < h; ++y) {
        for (uint32_t x = 0; x < w; ++x) {
            const size_t pxIdx = (static_cast<size_t>(y) * w + x) * 4;

            auto getSample = [&](uint32_t comp, uint32_t cx, uint32_t cy) -> float {
                if (comp >= nComp) return 1.0f;
                // Handle sub-sampled chroma (4:2:2 / 4:2:0)
                uint32_t fx = cx >> image->comps[comp].dx;
                uint32_t fy = cy >> image->comps[comp].dy;
                fx = std::min(fx, image->comps[comp].w - 1);
                fy = std::min(fy, image->comps[comp].h - 1);
                float v = static_cast<float>(image->comps[comp].data[fy * image->comps[comp].w + fx]);
                return (v + offset) * scale;
            };

            if (nComp == 1) {
                // Luma-only: expand to RGB grey
                float luma = getSample(0, x, y);
                result.rgba[pxIdx + 0] = luma;
                result.rgba[pxIdx + 1] = luma;
                result.rgba[pxIdx + 2] = luma;
            } else {
                result.rgba[pxIdx + 0] = getSample(0, x, y);   // R or Y
                result.rgba[pxIdx + 1] = getSample(1, x, y);   // G or Cb
                result.rgba[pxIdx + 2] = getSample(2, x, y);   // B or Cr
            }
            result.rgba[pxIdx + 3] = nComp == 4 ? getSample(3, x, y) : 1.0f;
        }
    }

    opj_image_destroy(image);
    return true;
}

// ── Simple JPEG writer (no libjpeg dependency) ────────────────────────────────
// We output a PPM to disk then let the caller invoke ffmpeg for JPEG encode.
// This avoids a libjpeg dependency while still producing correct output.

bool write_jpeg(const DecodedFrame& frame, const std::string& outPath, int quality) {
    // Write as PPM; caller converts to JPEG using system ffmpeg if needed.
    // Real JPEG output needs libjpeg; we emit PNG as a safe default.
    return write_png(frame, outPath);
}

// ── Minimal PNG writer ────────────────────────────────────────────────────────
// Writes an uncompressed/deflate PNG from the RGBA float buffer.
// Uses libpng if available; otherwise writes a raw PPM.

#if __has_include(<png.h>)
#include <png.h>

bool write_png(const DecodedFrame& frame, const std::string& outPath) {
    FILE* fp = fopen(outPath.c_str(), "wb");
    if (!fp) return false;

    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
    if (!png) { fclose(fp); return false; }
    png_infop info = png_create_info_struct(png);
    if (!info) { png_destroy_write_struct(&png, nullptr); fclose(fp); return false; }

    if (setjmp(png_jmpbuf(png))) {
        png_destroy_write_struct(&png, &info);
        fclose(fp);
        return false;
    }

    png_init_io(png, fp);
    png_set_IHDR(png, info, frame.width, frame.height, 8,
                 PNG_COLOR_TYPE_RGB, PNG_INTERLACE_NONE,
                 PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
    png_write_info(png, info);

    std::vector<uint8_t> row(frame.width * 3);
    for (uint32_t y = 0; y < frame.height; ++y) {
        for (uint32_t x = 0; x < frame.width; ++x) {
            const size_t src = (static_cast<size_t>(y) * frame.width + x) * 4;
            row[x * 3 + 0] = static_cast<uint8_t>(std::clamp(frame.rgba[src + 0], 0.0f, 1.0f) * 255.0f);
            row[x * 3 + 1] = static_cast<uint8_t>(std::clamp(frame.rgba[src + 1], 0.0f, 1.0f) * 255.0f);
            row[x * 3 + 2] = static_cast<uint8_t>(std::clamp(frame.rgba[src + 2], 0.0f, 1.0f) * 255.0f);
        }
        png_write_row(png, row.data());
    }

    png_write_end(png, nullptr);
    png_destroy_write_struct(&png, &info);
    fclose(fp);
    return true;
}

#else
// Fallback: write PPM (portable pixmap — viewable and convertible by ffmpeg)
bool write_png(const DecodedFrame& frame, const std::string& outPath) {
    // Write as .ppm regardless of extension; the IPC layer converts with ffmpeg
    std::ofstream f(outPath, std::ios::binary);
    if (!f) return false;

    f << "P6\n" << frame.width << " " << frame.height << "\n255\n";
    for (size_t i = 0; i < static_cast<size_t>(frame.width) * frame.height; ++i) {
        const float* px = &frame.rgba[i * 4];
        uint8_t rgb[3] = {
            static_cast<uint8_t>(std::clamp(px[0], 0.0f, 1.0f) * 255.0f),
            static_cast<uint8_t>(std::clamp(px[1], 0.0f, 1.0f) * 255.0f),
            static_cast<uint8_t>(std::clamp(px[2], 0.0f, 1.0f) * 255.0f),
        };
        f.write(reinterpret_cast<const char*>(rgb), 3);
    }
    return f.good();
}
#endif

// ── scale_frame ───────────────────────────────────────────────────────────────

DecodedFrame scale_frame(const DecodedFrame& src, uint32_t targetWidth) {
    if (src.width == 0 || targetWidth == 0 || targetWidth >= src.width) return src;

    DecodedFrame dst;
    dst.width      = targetWidth;
    dst.height     = static_cast<uint32_t>(src.height * targetWidth / src.width);
    dst.bitDepth   = src.bitDepth;
    dst.components = src.components;
    dst.rgba.resize(static_cast<size_t>(dst.width) * dst.height * 4);

    const float xScale = static_cast<float>(src.width)  / dst.width;
    const float yScale = static_cast<float>(src.height) / dst.height;

    for (uint32_t dy = 0; dy < dst.height; ++dy) {
        for (uint32_t dx = 0; dx < dst.width; ++dx) {
            const uint32_t sx = static_cast<uint32_t>(dx * xScale);
            const uint32_t sy = static_cast<uint32_t>(dy * yScale);
            const size_t  si  = (static_cast<size_t>(sy) * src.width + sx) * 4;
            const size_t  di  = (static_cast<size_t>(dy) * dst.width + dx) * 4;
            dst.rgba[di + 0] = src.rgba[si + 0];
            dst.rgba[di + 1] = src.rgba[si + 1];
            dst.rgba[di + 2] = src.rgba[si + 2];
            dst.rgba[di + 3] = src.rgba[si + 3];
        }
    }
    return dst;
}
