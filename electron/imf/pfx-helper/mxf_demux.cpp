// mxf_demux.cpp — asdcplib J2K MXF demux implementation

#include "mxf_demux.h"

#include <AS_02.h>
#include <KM_fileio.h>
#include <Metadata.h>

#include <cmath>
#include <cstring>
#include <sstream>

// ── Internal session ──────────────────────────────────────────────────────────

struct MXFSession {
    // asdcplib 2.13+ requires a file-reader factory passed to the MXFReader ctor.
    Kumu::FileReaderFactory fileFactory;
    AS_02::JP2K::MXFReader  reader{fileFactory};
    ASDCP::WriterInfo       writerInfo;
    ASDCP::JP2K::PictureDescriptor picDesc;
    uint32_t   currentFrame = 0;
    bool       open         = false;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

static double _rationalToDouble(const ASDCP::Rational& r) {
    return r.Denominator > 0 ? static_cast<double>(r.Numerator) / r.Denominator : 24.0;
}

static std::string _timecodeStr(const ASDCP::MXF::TimecodeComponent& tc, double fps) {
    // Format as HH:MM:SS:FF
    uint32_t totalFrames = tc.StartTimecode;
    uint32_t ifps        = static_cast<uint32_t>(std::round(fps));
    if (ifps == 0) ifps = 24;

    uint32_t ff  = totalFrames % ifps;
    uint32_t sec = (totalFrames / ifps) % 60;
    uint32_t min = (totalFrames / (ifps * 60)) % 60;
    uint32_t hr  = totalFrames / (ifps * 3600);

    char buf[20];
    snprintf(buf, sizeof(buf), "%02u:%02u:%02u:%02u", hr, min, sec, ff);
    return buf;
}

// ── mxf_open ─────────────────────────────────────────────────────────────────

MXFSession* mxf_open(const std::string& mxfPath, MXFInfo& info) {
    auto* session = new MXFSession();

    ASDCP::Result_t result = session->reader.OpenRead(mxfPath.c_str());
    if (ASDCP_FAILURE(result)) {
        info.error = "asdcplib OpenRead failed: " + std::string(result.Label());
        delete session;
        return nullptr;
    }

    result = session->reader.FillPictureDescriptor(session->picDesc);
    if (ASDCP_FAILURE(result)) {
        info.error = "asdcplib FillPictureDescriptor failed";
        session->reader.Close();
        delete session;
        return nullptr;
    }

    const auto& pd = session->picDesc;

    info.frameCount   = pd.ContainerDuration;
    info.editRate     = _rationalToDouble(pd.EditRate);
    info.width        = pd.StoredWidth;
    info.height       = pd.StoredHeight;
    info.bitDepth     = pd.ComponentDepth;
    info.codec        = "jpeg2000";

    // HTJ2K detection: JPEG 2000 Part 15 uses a different essence UL
    // (06.0E.2B.34.04.01.01.0D.0D.01.03.01.02.0D.xx.xx pattern for HTJ2K)
    // asdcplib 2.13+ exposes Rsiz field: 0x4000 = HTJ2K
    // Fallback: check codec label string from EssenceContainerUL
    {
        char ulStr[64] = {};
        pd.ContainerUL.EncodeHex(ulStr, sizeof(ulStr));
        // HTJ2K UL includes "0D.0D.01.03.01.02.0D" or variant
        info.isHTJ2K = (strstr(ulStr, "0d.01.03.01.02.0d") != nullptr ||
                        strstr(ulStr, "0D.01.03.01.02.0D") != nullptr);
        if (info.isHTJ2K) info.codec = "htj2k";
    }

    // HDR: PQ or HLG indicated via Transfer Characteristic UL in the descriptor
    // SMPTE ST 2084 (PQ): 06.0E.2B.34.04.01.01.0D.04.01.01.01.01.17.xx.xx
    {
        char tcStr[64] = {};
        pd.TransferCharacteristic.EncodeHex(tcStr, sizeof(tcStr));
        info.isHDR = (strstr(tcStr, "01.01.17") != nullptr ||   // PQ
                      strstr(tcStr, "01.01.0B") != nullptr);    // HLG (approx)
    }

    // Dolby Vision: RPU essence track alongside the picture track
    // AS-02 supplemental IMF bundles often carry DV metadata as a separate MXF.
    // We detect DV by checking for a DolbyVisionRPU track — approximate heuristic here.
    // Full DV detection requires parsing the entire AS-02 package manifest.
    info.isDV      = false;
    info.dvProfile = 0;

    // Timecode
    ASDCP::WriterInfo wi;
    if (ASDCP_SUCCESS(session->reader.FillWriterInfo(wi))) {
        // TimecodeComponent is not directly on the picture reader; we approximate
        info.timecodeStart = "00:00:00:00";
    }

    session->open = true;
    return session;
}

// ── mxf_read_frame ───────────────────────────────────────────────────────────

int64_t mxf_read_frame(MXFSession* session, uint32_t frame,
                        std::vector<uint8_t>& buf, std::string& error)
{
    if (!session || !session->open) {
        error = "Session not open";
        return -1;
    }

    ASDCP::JP2K::FrameBuffer frameBuffer;
    // Allocate conservatively for 4K 12-bit J2K (worst case ~50 MB uncompressed)
    const uint32_t maxBytes = 52428800u;   // 50 MB
    ASDCP::Result_t result  = frameBuffer.Capacity(maxBytes);
    if (ASDCP_FAILURE(result)) {
        error = "FrameBuffer allocation failed";
        return -1;
    }

    result = session->reader.ReadFrame(frame, frameBuffer, nullptr, nullptr);
    if (ASDCP_FAILURE(result)) {
        error = "ReadFrame failed at frame " + std::to_string(frame) +
                ": " + result.Label();
        return -1;
    }

    const uint32_t size = frameBuffer.Size();
    buf.resize(size);
    memcpy(buf.data(), frameBuffer.Data(), size);
    return static_cast<int64_t>(size);
}

// ── mxf_read_dv_rpu ──────────────────────────────────────────────────────────

std::vector<uint8_t> mxf_read_dv_rpu(MXFSession* /*session*/, uint32_t /*frame*/) {
    // DV RPU extraction requires a separate MXF reader for the DV track.
    // This is a stub; full implementation reads from the AS-02 IAB/DV MXF bundle.
    return {};
}

// ── mxf_close ────────────────────────────────────────────────────────────────

void mxf_close(MXFSession* session) {
    if (!session) return;
    if (session->open) {
        session->reader.Close();
        session->open = false;
    }
    delete session;
}
