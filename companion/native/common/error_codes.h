// companion/native/common/error_codes.h
// Shared error codes for the PostFlowX native helper.
// These mirror mediaTypes.js ERROR_CODE constants exactly.
#pragma once
#include <string>

namespace pfx {

struct ErrorCode {
    static constexpr const char* HELPER_NOT_INSTALLED   = "helper_not_installed";
    static constexpr const char* BACKEND_NOT_AVAILABLE  = "backend_not_available";
    static constexpr const char* SDK_MISSING            = "sdk_missing";
    static constexpr const char* UNSUPPORTED_FORMAT     = "unsupported_format";
    static constexpr const char* FILE_OPEN_FAILED       = "file_open_failed";
    static constexpr const char* DECODE_FAILED          = "decode_failed";
    static constexpr const char* PERMISSION_DENIED      = "permission_denied";
    static constexpr const char* PLATFORM_NOT_SUPPORTED = "platform_not_supported";
    static constexpr const char* SESSION_NOT_FOUND      = "session_not_found";
    static constexpr const char* BAD_REQUEST            = "bad_request";
    static constexpr const char* TIMEOUT                = "timeout";
};

}  // namespace pfx
