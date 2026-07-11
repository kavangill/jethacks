#include "core/claude_client.hpp"

#include <curl/curl.h>

#include <algorithm>

namespace cadgod {

namespace {

std::size_t writeCallback(char* data, std::size_t size, std::size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(data, size * nmemb);
    return size * nmemb;
}

}  // namespace

HttpResponse CurlTransport::post(const std::string& url, const std::vector<std::string>& headers,
                                 const std::string& body) {
    HttpResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) {
        resp.error = "curl_easy_init failed";
        return resp;
    }
    curl_slist* headerList = nullptr;
    for (const auto& h : headers) headerList = curl_slist_append(headerList, h.c_str());

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headerList);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeoutSeconds_);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "cadgod/0.1");

    CURLcode rc = curl_easy_perform(curl);
    if (rc != CURLE_OK) {
        resp.error = curl_easy_strerror(rc);
    } else {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
    }
    curl_slist_free_all(headerList);
    curl_easy_cleanup(curl);
    return resp;
}

ClaudeClient::ClaudeClient(std::string apiKey, std::string model, HttpTransport* transport)
    : apiKey_(std::move(apiKey)), model_(std::move(model)), transport_(transport) {}

Json ClaudeClient::textBlock(const std::string& text) {
    Json b = Json::object();
    b["type"] = "text";
    b["text"] = text;
    return b;
}

Json ClaudeClient::imageBlock(const std::string& mediaType, const std::string& base64Data) {
    Json source = Json::object();
    source["type"] = "base64";
    source["media_type"] = mediaType;
    source["data"] = base64Data;
    Json b = Json::object();
    b["type"] = "image";
    b["source"] = source;
    return b;
}

Json ClaudeClient::userMessage(Json contentBlocks) {
    Json m = Json::object();
    m["role"] = "user";
    m["content"] = std::move(contentBlocks);
    return m;
}

std::string ClaudeClient::base64Encode(const std::string& bytes) {
    static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);
    std::size_t i = 0;
    while (i + 2 < bytes.size()) {
        unsigned v = (static_cast<unsigned char>(bytes[i]) << 16) |
                     (static_cast<unsigned char>(bytes[i + 1]) << 8) |
                     static_cast<unsigned char>(bytes[i + 2]);
        out += table[(v >> 18) & 63];
        out += table[(v >> 12) & 63];
        out += table[(v >> 6) & 63];
        out += table[v & 63];
        i += 3;
    }
    if (i + 1 == bytes.size()) {
        unsigned v = static_cast<unsigned char>(bytes[i]) << 16;
        out += table[(v >> 18) & 63];
        out += table[(v >> 12) & 63];
        out += "==";
    } else if (i + 2 == bytes.size()) {
        unsigned v = (static_cast<unsigned char>(bytes[i]) << 16) |
                     (static_cast<unsigned char>(bytes[i + 1]) << 8);
        out += table[(v >> 18) & 63];
        out += table[(v >> 12) & 63];
        out += table[(v >> 6) & 63];
        out += '=';
    }
    return out;
}

std::string ClaudeClient::mediaTypeForPath(const std::string& path) {
    auto ends = [&](const char* suffix) {
        std::string s = path;
        std::transform(s.begin(), s.end(), s.begin(), ::tolower);
        std::string suf(suffix);
        return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
    };
    if (ends(".jpg") || ends(".jpeg")) return "image/jpeg";
    if (ends(".gif")) return "image/gif";
    if (ends(".webp")) return "image/webp";
    return "image/png";
}

ClaudeResult ClaudeClient::complete(const std::string& system, const Json& messages,
                                    const ClaudeOptions& opts) {
    Json body = Json::object();
    body["model"] = model_;
    body["max_tokens"] = opts.maxTokens;
    if (!system.empty()) body["system"] = system;
    body["messages"] = messages;
    if (opts.adaptiveThinking) {
        Json thinking = Json::object();
        thinking["type"] = "adaptive";
        body["thinking"] = thinking;
    }
    if (!opts.outputSchema.isNull()) {
        Json format = Json::object();
        format["type"] = "json_schema";
        format["schema"] = opts.outputSchema;
        Json outputConfig = Json::object();
        outputConfig["format"] = format;
        body["output_config"] = outputConfig;
    }

    std::vector<std::string> headers = {
        "content-type: application/json",
        "x-api-key: " + apiKey_,
        "anthropic-version: 2023-06-01",
    };

    HttpResponse resp = transport_->post(kApiUrl, headers, body.dump());

    ClaudeResult result;
    if (!resp.error.empty()) {
        result.error = "transport error: " + resp.error;
        return result;
    }

    Json parsed;
    try {
        parsed = Json::parse(resp.body);
    } catch (const std::exception& e) {
        result.error = "invalid JSON response (HTTP " + std::to_string(resp.status) + "): " + e.what();
        return result;
    }

    if (resp.status != 200) {
        std::string msg = "HTTP " + std::to_string(resp.status);
        if (const Json* err = parsed.find("error")) {
            msg += " " + err->getString("type") + ": " + err->getString("message");
        }
        result.error = msg;
        return result;
    }

    result.stopReason = parsed.getString("stop_reason");
    if (const Json* usage = parsed.find("usage")) {
        result.inputTokens = static_cast<long>(usage->getNumber("input_tokens"));
        result.outputTokens = static_cast<long>(usage->getNumber("output_tokens"));
    }
    if (result.stopReason == "refusal") {
        result.error = "model refused the request (stop_reason: refusal)";
        return result;
    }
    if (const Json* content = parsed.find("content"); content && content->isArray()) {
        for (const auto& block : content->items()) {
            if (block.getString("type") == "text") result.text += block.getString("text");
        }
    }
    result.ok = true;
    return result;
}

}  // namespace cadgod
