// companion/native/messaging/native_messaging_io.h
// Chrome Native Messaging I/O — 4-byte length-prefixed JSON messages.
#pragma once
#include <string>
#include <functional>
#include <cstdint>

namespace pfx {

// Read one message from stdin (blocking).
// Returns empty string on EOF or error.
std::string readMessage();

// Write one message to stdout (blocking).
void writeMessage(const std::string& jsonPayload);

// Run the message loop: read messages, dispatch via handler, write responses.
// handler(requestJson) → responseJson
void runMessageLoop(std::function<std::string(const std::string&)> handler);

}  // namespace pfx
