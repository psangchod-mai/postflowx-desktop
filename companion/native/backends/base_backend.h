// companion/native/backends/base_backend.h
// Abstract backend interface — all C++ backends implement this.
// Mirrors base_backend.py BaseMediaBackend exactly.
#pragma once
#include <string>
#include <memory>
#include "../common/media_types.h"

namespace pfx {

class IMediaBackend {
public:
    virtual ~IMediaBackend() = default;

    virtual std::string backendKey() const = 0;

    // True if this backend can attempt to open path
    virtual bool canOpen(const std::string& path) const = 0;

    // Open file; returns opaque session handle (int or pointer)
    // Throws std::runtime_error on failure
    virtual intptr_t open(const std::string& path, const std::string& quality) = 0;

    // Release resources for a session handle
    virtual void close(intptr_t sessionHandle) = 0;

    // Read file metadata
    virtual MediaMetadata getMetadata(intptr_t sessionHandle) = 0;

    // Decode a still frame at frameIndex
    // quality: "full" | "half" | "quarter"
    // format:  "jpg"  | "png"
    virtual PreviewFrame getFrame(intptr_t sessionHandle, int frameIndex,
                                  const std::string& quality,
                                  const std::string& format,
                                  int width, int height) = 0;

    // Seek without decode
    virtual void seek(intptr_t sessionHandle, int frameIndex) = 0;

    // Static capabilities
    virtual BackendCapabilities getCapabilities() const = 0;

    // Live status: {status, decodeMode, version, lastError}
    virtual std::string getStatus() const = 0;
    virtual std::string getVersion() const { return ""; }
    virtual std::string getLastError() const { return ""; }
};

}  // namespace pfx
