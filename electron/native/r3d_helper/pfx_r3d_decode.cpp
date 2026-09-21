/* pfx_r3d_decode — PostFlowX native RED R3D decode helper.
 *
 * Why this exists (Dev Brief P1#4): the official R3D SDK on macOS ships ONLY a
 * C++ static archive (Lib/mac64/libR3DSDK-libcpp.a) plus runtime "redistributable"
 * dylibs (REDR3D.dylib etc). The Python companion's r3d_backend can therefore NOT
 * ctypes-load the SDK (you cannot dlopen a .a, and REDR3D.dylib exports no API
 * symbols — only the static lib has R3DSDK::InitializeSdk). So full R3D frame
 * decode must go through a small native CLI that links the static lib. This is it.
 * Mirrors the avf_bridge / pfx_native_media_engine helper pattern.
 *
 * The SDK redistributable dylibs must sit next to this binary (or be pointed at by
 * PFX_R3DSDK_LIBDIR); InitializeSdk() is given that folder.
 *
 * Commands (all output JSON on stdout; raw pixels go to the output file):
 *   pfx_r3d_decode version
 *   pfx_r3d_decode probe  <clip.R3D>
 *   pfx_r3d_decode decode <clip.R3D> <frameNo> <mode> <pixfmt> <outRaw>
 *       mode   : full | half | halfgood | quarter | eighth | sixteenth
 *       pixfmt : bgra8 | rgbhalf | aceshalf
 *
 * Exit code 0 on success, non-zero on error (with {"ok":false,"error":...} JSON).
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <mach-o/dyld.h>   // _NSGetExecutablePath
#include <libgen.h>        // dirname

#include "R3DSDK.h"

using namespace R3DSDK;

// ---- small JSON string escaper (paths can contain quotes/backslashes) --------
static std::string jescape(const std::string & s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:   o += c;      break;
        }
    }
    return o;
}

static int fail(const char * msg, int code) {
    printf("{\"ok\":false,\"error\":\"%s\"}\n", jescape(msg).c_str());
    return code;
}

// Directory holding the SDK redistributable dylibs: env override, else the
// directory this executable lives in (dylibs are bundled side-by-side).
static std::string sdk_lib_dir() {
    const char * env = getenv("PFX_R3DSDK_LIBDIR");
    if (env && *env) return std::string(env);
    char buf[4096];
    uint32_t sz = sizeof(buf);
    if (_NSGetExecutablePath(buf, &sz) == 0) {
        // dirname may mutate its argument — give it a copy
        std::string p(buf);
        std::string copy = p;
        char * d = dirname(&copy[0]);
        if (d) return std::string(d);
    }
    return std::string(".");
}

// 16-byte-aligned malloc (SDK requires aligned output buffer). Returns the
// aligned pointer; *origOut receives the malloc base to free later.
static unsigned char * aligned_alloc16(size_t bytes, unsigned char ** origOut) {
    unsigned char * base = (unsigned char *)malloc(bytes + 15U);
    *origOut = base;
    if (!base) return nullptr;
    uintptr_t p = (uintptr_t)base;
    uintptr_t pad = (p % 16U) ? (16U - (p % 16U)) : 0U;
    return base + pad;
}

static bool parse_mode(const std::string & m, VideoDecodeMode & out, int & div) {
    if (m == "full")       { out = DECODE_FULL_RES_PREMIUM;  div = 1;  return true; }
    if (m == "half")       { out = DECODE_HALF_RES_PREMIUM;  div = 2;  return true; }
    if (m == "halfgood")   { out = DECODE_HALF_RES_GOOD;     div = 2;  return true; }
    if (m == "quarter")    { out = DECODE_QUARTER_RES_GOOD;  div = 4;  return true; }
    if (m == "eighth")     { out = DECODE_EIGHT_RES_GOOD;    div = 8;  return true; }
    if (m == "sixteenth")  { out = DECODE_SIXTEENTH_RES_GOOD;div = 16; return true; }
    return false;
}

// returns bytes-per-pixel; sets channel/bit metadata for the JSON header
static bool parse_pixfmt(const std::string & f, VideoPixelType & out,
                         int & bpp, int & channels, int & bits, const char ** name) {
    if (f == "bgra8")   { out = PixelType_8Bit_BGRA_Interleaved;   bpp = 4; channels = 4; bits = 8;  *name = "bgra8";   return true; }
    if (f == "rgbhalf") { out = PixelType_HalfFloat_RGB_Interleaved;bpp = 6; channels = 3; bits = 16; *name = "rgbhalf"; return true; }
    if (f == "aceshalf"){ out = PixelType_HalfFloat_RGB_ACES_Int;  bpp = 6; channels = 3; bits = 16; *name = "aceshalf";return true; }
    return false;
}

static int cmd_version() {
    std::string dir = sdk_lib_dir();
    InitializeStatus st = InitializeSdk(dir.c_str(), OPTION_RED_NONE);
    if (st != ISInitializeOK) {
        // still report — GetSdkVersion is valid even on init failure
        printf("{\"ok\":false,\"error\":\"InitializeSdk failed\",\"status\":%d,"
               "\"sdkVersion\":\"%s\",\"libDir\":\"%s\"}\n",
               (int)st, jescape(GetSdkVersion()).c_str(), jescape(dir).c_str());
        FinalizeSdk();
        return 2;
    }
    printf("{\"ok\":true,\"sdkVersion\":\"%s\",\"libDir\":\"%s\"}\n",
           jescape(GetSdkVersion()).c_str(), jescape(dir).c_str());
    FinalizeSdk();
    return 0;
}

static int cmd_probe(const char * path) {
    std::string dir = sdk_lib_dir();
    if (InitializeSdk(dir.c_str(), OPTION_RED_NONE) != ISInitializeOK) {
        FinalizeSdk();
        return fail("InitializeSdk failed", 2);
    }
    Clip * clip = new Clip(path);
    if (clip->Status() != LSClipLoaded) {
        int s = (int)clip->Status();
        delete clip; FinalizeSdk();
        char m[128]; snprintf(m, sizeof(m), "clip load failed (status %d)", s);
        return fail(m, 3);
    }
    unsigned int w   = (unsigned int)clip->Width();
    unsigned int h   = (unsigned int)clip->Height();
    unsigned int n   = (unsigned int)clip->VideoFrameCount();
    float fps        = clip->VideoAudioFramerate();
    float tcfps      = clip->TimecodeFramerate();
    const char * tcS = clip->AbsoluteTimecode(0U);
    const char * tcE = n ? clip->AbsoluteTimecode(n - 1U) : "";

    printf("{\"ok\":true,\"width\":%u,\"height\":%u,\"frameCount\":%u,"
           "\"fps\":%.6f,\"timecodeFps\":%.6f,\"startTimecode\":\"%s\","
           "\"endTimecode\":\"%s\",\"sdkVersion\":\"%s\"}\n",
           w, h, n, fps, tcfps,
           jescape(tcS ? tcS : "").c_str(),
           jescape(tcE ? tcE : "").c_str(),
           jescape(GetSdkVersion()).c_str());

    delete clip;
    FinalizeSdk();
    return 0;
}

static int cmd_decode(const char * path, const char * frameStr,
                      const char * modeStr, const char * pixStr,
                      const char * outPath) {
    VideoDecodeMode mode; int div = 1;
    if (!parse_mode(modeStr, mode, div))
        return fail("bad mode (full|half|halfgood|quarter|eighth|sixteenth)", 10);

    VideoPixelType pix; int bpp = 0, channels = 0, bits = 0; const char * pixName = "";
    if (!parse_pixfmt(pixStr, pix, bpp, channels, bits, &pixName))
        return fail("bad pixfmt (bgra8|rgbhalf|aceshalf)", 11);

    size_t frameNo = (size_t)strtoull(frameStr, nullptr, 10);

    std::string dir = sdk_lib_dir();
    if (InitializeSdk(dir.c_str(), OPTION_RED_NONE) != ISInitializeOK) {
        FinalizeSdk();
        return fail("InitializeSdk failed", 2);
    }
    Clip * clip = new Clip(path);
    if (clip->Status() != LSClipLoaded) {
        int s = (int)clip->Status();
        delete clip; FinalizeSdk();
        char m[128]; snprintf(m, sizeof(m), "clip load failed (status %d)", s);
        return fail(m, 3);
    }
    if (frameNo >= clip->VideoFrameCount()) {
        delete clip; FinalizeSdk();
        return fail("frame index out of range", 12);
    }

    size_t outW = clip->Width()  / (size_t)div;
    size_t outH = clip->Height() / (size_t)div;
    size_t rowBytes = outW * (size_t)bpp;
    size_t memNeeded = rowBytes * outH;

    unsigned char * orig = nullptr;
    unsigned char * imgbuf = aligned_alloc16(memNeeded, &orig);
    if (!imgbuf) {
        delete clip; FinalizeSdk();
        return fail("out of memory for output buffer", 13);
    }

    VideoDecodeJob job;            // ctor sets sane defaults
    job.Mode            = mode;
    job.PixelType       = pix;
    job.OutputBuffer    = imgbuf;
    job.OutputBufferSize = memNeeded;
    job.ImageProcessing = nullptr; // clip default look
    job.HdrProcessing   = nullptr;

    DecodeStatus ds = clip->DecodeVideoFrame(frameNo, job);
    if (ds != DSDecodeOK) {
        free(orig); delete clip; FinalizeSdk();
        char m[96]; snprintf(m, sizeof(m), "DecodeVideoFrame failed (status %d)", (int)ds);
        return fail(m, 14);
    }

    FILE * f = fopen(outPath, "wb");
    if (!f) {
        free(orig); delete clip; FinalizeSdk();
        return fail("cannot open output file", 15);
    }
    size_t wrote = fwrite(imgbuf, 1, memNeeded, f);
    fclose(f);
    free(orig);
    delete clip;
    FinalizeSdk();

    if (wrote != memNeeded)
        return fail("short write to output file", 16);

    printf("{\"ok\":true,\"width\":%u,\"height\":%u,\"pixfmt\":\"%s\","
           "\"channels\":%d,\"bitsPerChannel\":%d,\"rowBytes\":%u,\"bytes\":%u}\n",
           (unsigned)outW, (unsigned)outH, pixName, channels, bits,
           (unsigned)rowBytes, (unsigned)memNeeded);
    return 0;
}

int main(int argc, char * argv[]) {
    if (argc < 2) return fail("usage: pfx_r3d_decode version|probe|decode ...", 1);
    std::string cmd = argv[1];
    if (cmd == "version") return cmd_version();
    if (cmd == "probe") {
        if (argc != 3) return fail("usage: probe <clip.R3D>", 1);
        return cmd_probe(argv[2]);
    }
    if (cmd == "decode") {
        if (argc != 7) return fail("usage: decode <clip.R3D> <frameNo> <mode> <pixfmt> <outRaw>", 1);
        return cmd_decode(argv[2], argv[3], argv[4], argv[5], argv[6]);
    }
    return fail("unknown command", 1);
}
