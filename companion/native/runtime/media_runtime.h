// companion/native/runtime/media_runtime.h
// C++ native helper media runtime — Phase 1 scaffold.
// Full implementation deferred — Python companion handles Phase 1.
#pragma once
#include <string>
#include <memory>
#include <unordered_map>
#include "../backends/base_backend.h"
#include "../common/media_types.h"

namespace pfx {

struct MediaSession {
    std::string  sessionId;
    std::string  filePath;
    std::string  fileType;
    std::string  backend;
    intptr_t     sessionHandle = 0;
    MediaMetadata metadata;
    BackendCapabilities capabilities;
    std::string  cacheState;  // "pending" | "ready" | "error" | "closed"
    std::string  lastError;
};

class MediaRuntime {
public:
    MediaRuntime();
    ~MediaRuntime();

    // Register a backend implementation
    void registerBackend(std::shared_ptr<IMediaBackend> backend);

    // Open a file — returns session ID
    std::string openFile(const std::string& path, const std::string& preferredBackend,
                         const std::string& quality);

    // Close session
    void closeFile(const std::string& sessionId);

    // Get metadata for session
    MediaMetadata getMetadata(const std::string& sessionId);

    // Decode a frame
    PreviewFrame getFrame(const std::string& sessionId, int frameIndex,
                          const std::string& quality, const std::string& format,
                          int width, int height);

    // Seek
    void seekFrame(const std::string& sessionId, int frameIndex);

    // List all active sessions
    std::vector<std::string> listSessions() const;

private:
    std::unordered_map<std::string, std::shared_ptr<IMediaBackend>> _backends;
    std::unordered_map<std::string, MediaSession> _sessions;

    IMediaBackend* selectBackend(const std::string& path,
                                  const std::string& preferred) const;
    std::string generateSessionId() const;
};

}  // namespace pfx
