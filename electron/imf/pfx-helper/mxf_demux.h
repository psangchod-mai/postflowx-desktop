#pragma once
// mxf_demux.h — asdcplib wrapper for J2K MXF demux + frame-accurate read

#include <cstdint>
#include <string>
#include <vector>

struct MXFInfo {
    uint32_t    frameCount     = 0;
    double      editRate       = 24.0;
    std::string timecodeStart;       // "HH:MM:SS:FF"
    uint32_t    width          = 0;
    uint32_t    height         = 0;
    uint32_t    bitDepth       = 12;
    bool        isHTJ2K        = false;   // JPEG 2000 Part 15 (HTJ2K)
    bool        isHDR          = false;   // PQ / HLG transfer indicated in descriptor
    bool        isDV           = false;   // Dolby Vision RPU present
    uint8_t     dvProfile      = 0;
    std::string codec;                    // "jpeg2000" or "htj2k"
    std::string error;
};

// Opaque session handle (hides asdcplib types from callers)
struct MXFSession;

// Open an MXF file; returns null on failure (check info.error).
MXFSession* mxf_open(const std::string& mxfPath, MXFInfo& info);

// Extract raw J2K/HTJ2K codestream bytes for the given 0-based frame.
// Returns byte count written into `buf`; -1 on error.
int64_t mxf_read_frame(MXFSession* session, uint32_t frame,
                       std::vector<uint8_t>& buf, std::string& error);

// Read the Dolby Vision RPU (metadata) for the given frame, if present.
// Returns the RPU bytes; empty vector if not available.
std::vector<uint8_t> mxf_read_dv_rpu(MXFSession* session, uint32_t frame);

void mxf_close(MXFSession* session);
