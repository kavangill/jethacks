#pragma once
// Claude Messages API client over raw HTTPS (libcurl). C++ has no official
// Anthropic SDK, so this speaks the wire format directly:
//   POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version: 2023-06-01, content-type
// Transport is injectable so tests never touch the network.

#include <memory>
#include <string>
#include <vector>

#include "core/json.hpp"

namespace cadgod {

struct HttpResponse {
    long status = 0;
    std::string body;
    std::string error;  // transport-level failure (non-empty means no HTTP response)
};

class HttpTransport {
public:
    virtual ~HttpTransport() = default;
    virtual HttpResponse post(const std::string& url, const std::vector<std::string>& headers,
                              const std::string& body) = 0;
};

class CurlTransport final : public HttpTransport {
public:
    explicit CurlTransport(long timeoutSeconds = 300) : timeoutSeconds_(timeoutSeconds) {}
    HttpResponse post(const std::string& url, const std::vector<std::string>& headers,
                      const std::string& body) override;

private:
    long timeoutSeconds_;
};

struct ClaudeOptions {
    int maxTokens = 4096;
    bool adaptiveThinking = false;  // thinking: {type: "adaptive"}
    Json outputSchema;              // non-null -> output_config.format json_schema
};

struct ClaudeResult {
    bool ok = false;
    std::string error;       // set when !ok
    std::string text;        // concatenated text blocks
    std::string stopReason;  // end_turn / max_tokens / refusal / ...
    long inputTokens = 0;
    long outputTokens = 0;
};

class ClaudeClient {
public:
    ClaudeClient(std::string apiKey, std::string model, HttpTransport* transport);

    // messages: JSON array of {role, content} per the Messages API.
    ClaudeResult complete(const std::string& system, const Json& messages,
                          const ClaudeOptions& opts = {});

    const std::string& model() const { return model_; }

    // Content block helpers
    static Json textBlock(const std::string& text);
    static Json imageBlock(const std::string& mediaType, const std::string& base64Data);
    static Json userMessage(Json contentBlocks);

    static std::string base64Encode(const std::string& bytes);
    static std::string mediaTypeForPath(const std::string& path);  // by extension

    static constexpr const char* kApiUrl = "https://api.anthropic.com/v1/messages";

private:
    std::string apiKey_;
    std::string model_;
    HttpTransport* transport_;
};

}  // namespace cadgod
