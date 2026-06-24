// main.cpp — pfx-helper: asdcplib demux + OpenJPEG decode + libplacebo HDR render
//
// Protocol: newline-delimited JSON on stdin/stdout (one command per line).
//
// Commands (from imf_native_decoder.js):
//   { "id": N, "cmd": "openFile",     "path": "..." }
//   { "id": N, "cmd": "getInfo" }
//   { "id": N, "cmd": "seekFrame",    "frame": F, "outputPath": "...", "displayMode": "sdr|hdr|raw", "outputWidth": W }
//   { "id": N, "cmd": "stepFrame",    "direction": "forward|backward", "outputPath": "...", "displayMode": "...", "outputWidth": W }
//   { "id": N, "cmd": "grabThumbnail","frame": F, "outputPath": "...", "width": W }
//   { "id": N, "cmd": "close" }
//
// Response always has "id" matching the request and "ok": true/false.

#include "mxf_demux.h"
#include "j2k_decode.h"
#include "hdr_render.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>

// ── Tiny JSON helpers ─────────────────────────────────────────────────────────
// We avoid a full JSON library dependency; the protocol only has scalar values.

static std::string _jStr(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"')  out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else out += c;
    }
    return out + "\"";
}

static std::string _jOk(int id, const std::string& fields = "") {
    std::string r = "{\"id\":" + std::to_string(id) + ",\"ok\":true";
    if (!fields.empty()) r += "," + fields;
    return r + "}";
}

static std::string _jErr(int id, const std::string& msg) {
    return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"error\":" + _jStr(msg) + "}";
}

// Minimal JSON key extractor: returns raw value (string without quotes, number as string)
static std::string _jGet(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos += needle.size();
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == ':')) ++pos;
    if (pos >= json.size()) return "";
    if (json[pos] == '"') {
        // String value
        ++pos;
        std::string val;
        while (pos < json.size() && json[pos] != '"') {
            if (json[pos] == '\\' && pos + 1 < json.size()) { ++pos; }
            val += json[pos++];
        }
        return val;
    }
    // Number / bool / null — read until delimiter
    std::string val;
    while (pos < json.size() && json[pos] != ',' && json[pos] != '}' && json[pos] != ' ') {
        val += json[pos++];
    }
    return val;
}

static int _jGetInt(const std::string& json, const std::string& key, int def = 0) {
    const std::string v = _jGet(json, key);
    if (v.empty()) return def;
    try { return std::stoi(v); } catch (...) { return def; }
}

// ── Session state ─────────────────────────────────────────────────────────────

struct Session {
    std::string   mxfPath;
    MXFSession*   mxf         = nullptr;
    MXFInfo       info;
    uint32_t      currentFrame = 0;
};

static std::unique_ptr<Session> _session;

// ── Command handlers ──────────────────────────────────────────────────────────

static std::string _cmdOpenFile(int id, const std::string& json) {
    const std::string p = _jGet(json, "path");
    if (p.empty()) return _jErr(id, "missing path");

    if (_session) {
        if (_session->mxf) mxf_close(_session->mxf);
        _session.reset();
    }

    auto s = std::make_unique<Session>();
    s->mxfPath = p;
    s->mxf     = mxf_open(p, s->info);
    if (!s->mxf) return _jErr(id, s->info.error.empty() ? "mxf_open failed" : s->info.error);

    _session = std::move(s);
    return _jOk(id);
}

static std::string _cmdGetInfo(int id) {
    if (!_session || !_session->mxf) return _jErr(id, "no file open");
    const MXFInfo& i = _session->info;
    std::string f =
        "\"frameCount\":" + std::to_string(i.frameCount) +
        ",\"editRate\":"  + std::to_string(i.editRate)   +
        ",\"timecodeStart\":" + _jStr(i.timecodeStart)   +
        ",\"codec\":"     + _jStr(i.codec)                +
        ",\"width\":"     + std::to_string(i.width)       +
        ",\"height\":"    + std::to_string(i.height)      +
        ",\"bitDepth\":"  + std::to_string(i.bitDepth)    +
        ",\"isHTJ2K\":"   + (i.isHTJ2K ? "true" : "false") +
        ",\"isHDR\":"     + (i.isHDR   ? "true" : "false") +
        ",\"isDV\":"      + (i.isDV    ? "true" : "false");
    return _jOk(id, f);
}

static std::string _decodeAndRender(int id, uint32_t frame,
                                     const std::string& outPath,
                                     const std::string& modeStr,
                                     uint32_t outputWidth)
{
    if (!_session || !_session->mxf) return _jErr(id, "no file open");
    if (frame >= _session->info.frameCount)
        return _jErr(id, "frame out of range");

    std::vector<uint8_t> codestreamBuf;
    std::string readErr;
    int64_t sz = mxf_read_frame(_session->mxf, frame, codestreamBuf, readErr);
    if (sz < 0) return _jErr(id, readErr);

    DecodedFrame decoded;
    if (!j2k_decode(codestreamBuf.data(), static_cast<size_t>(sz),
                    _session->info.isHTJ2K, decoded)) {
        return _jErr(id, decoded.error.empty() ? "j2k_decode failed" : decoded.error);
    }

    DisplayMode mode = DisplayMode::SDR;
    if (modeStr == "hdr") mode = DisplayMode::HDR;
    else if (modeStr == "raw") mode = DisplayMode::RAW;

    // Read Dolby Vision RPU if available
    std::vector<uint8_t> dvRpu = mxf_read_dv_rpu(_session->mxf, frame);

    RenderResult rr = hdr_render(decoded, dvRpu, mode,
                                  _session->info.isHDR, outPath,
                                  outputWidth > 0 ? outputWidth : 1920);
    if (!rr.ok) return _jErr(id, rr.error);

    _session->currentFrame = frame;

    std::string f =
        "\"frame\":"          + std::to_string(frame) +
        ",\"toneMapApplied\":" + (rr.toneMapApplied ? "true" : "false");
    if (!rr.dvProfile.empty())
        f += ",\"dvProfile\":" + _jStr(rr.dvProfile);
    return _jOk(id, f);
}

static std::string _cmdSeekFrame(int id, const std::string& json) {
    if (!_session) return _jErr(id, "no file open");
    uint32_t frame       = static_cast<uint32_t>(_jGetInt(json, "frame", 0));
    std::string outPath  = _jGet(json, "outputPath");
    std::string mode     = _jGet(json, "displayMode");
    uint32_t    width    = static_cast<uint32_t>(_jGetInt(json, "outputWidth", 1920));
    if (outPath.empty()) return _jErr(id, "missing outputPath");
    return _decodeAndRender(id, frame, outPath, mode, width);
}

static std::string _cmdStepFrame(int id, const std::string& json) {
    if (!_session) return _jErr(id, "no file open");
    std::string dir     = _jGet(json, "direction");
    std::string outPath = _jGet(json, "outputPath");
    std::string mode    = _jGet(json, "displayMode");
    uint32_t    width   = static_cast<uint32_t>(_jGetInt(json, "outputWidth", 1920));
    if (outPath.empty()) return _jErr(id, "missing outputPath");

    uint32_t next = _session->currentFrame;
    if (dir == "forward") {
        next = std::min(next + 1u, _session->info.frameCount - 1u);
    } else {
        next = next > 0 ? next - 1u : 0u;
    }
    return _decodeAndRender(id, next, outPath, mode, width);
}

static std::string _cmdGrabThumbnail(int id, const std::string& json) {
    if (!_session) return _jErr(id, "no file open");
    uint32_t    frame   = static_cast<uint32_t>(_jGetInt(json, "frame", 0));
    std::string outPath = _jGet(json, "outputPath");
    uint32_t    width   = static_cast<uint32_t>(_jGetInt(json, "width", 320));
    if (outPath.empty()) return _jErr(id, "missing outputPath");

    std::vector<uint8_t> buf;
    std::string err;
    if (mxf_read_frame(_session->mxf, frame, buf, err) < 0)
        return _jErr(id, err);

    DecodedFrame decoded;
    if (!j2k_decode(buf.data(), buf.size(), _session->info.isHTJ2K, decoded))
        return _jErr(id, decoded.error);

    std::vector<uint8_t> noRpu;
    RenderResult rr = hdr_render(decoded, noRpu, DisplayMode::SDR,
                                  _session->info.isHDR, outPath, width, 60);
    if (!rr.ok) return _jErr(id, rr.error);

    return _jOk(id, "\"frame\":" + std::to_string(frame));
}

static std::string _cmdVersion(int id) {
    return _jOk(id, "\"version\":\"pfx-helper 1.0.0 (asdcplib+OpenJPEG"
#ifdef HAVE_LIBPLACEBO
                    "+libplacebo"
#endif
                    ")\"");
}

// ── IPC loop ──────────────────────────────────────────────────────────────────

static std::string _dispatch(const std::string& line) {
    const int   id  = _jGetInt(line, "id", 0);
    std::string cmd = _jGet(line, "cmd");

    if (cmd == "openFile")      return _cmdOpenFile(id, line);
    if (cmd == "getInfo")       return _cmdGetInfo(id);
    if (cmd == "seekFrame")     return _cmdSeekFrame(id, line);
    if (cmd == "stepFrame")     return _cmdStepFrame(id, line);
    if (cmd == "grabThumbnail") return _cmdGrabThumbnail(id, line);
    if (cmd == "version")       return _cmdVersion(id);
    if (cmd == "close") {
        if (_session) {
            if (_session->mxf) mxf_close(_session->mxf);
            _session.reset();
        }
        return _jOk(id);
    }
    return _jErr(id, "unknown command: " + cmd);
}

int main(int argc, char* argv[]) {
    // pfx-helper --version  (non-IPC mode, used for availability check)
    if (argc >= 2 && (strcmp(argv[1], "--version") == 0 || strcmp(argv[1], "-V") == 0)) {
        std::cout << "pfx-helper 1.0.0 (asdcplib+OpenJPEG"
#ifdef HAVE_LIBPLACEBO
                  << "+libplacebo"
#endif
                  << ")" << std::endl;
        return 0;
    }

    // IPC mode: read newline-delimited JSON from stdin, write responses to stdout.
    hdr_init_gpu();

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() || line.front() == '#') continue;
        const std::string response = _dispatch(line);
        std::cout << response << "\n";
        std::cout.flush();
    }

    hdr_shutdown_gpu();
    if (_session && _session->mxf) mxf_close(_session->mxf);
    return 0;
}
