#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <map>
#include <memory>

namespace dominusnode {

class TokenManager;

/// HTTP response from the server.
struct HttpResponse {
    long status_code = 0;
    std::string body;
    std::map<std::string, std::string> headers;
};

/// Low-level HTTP client built on libcurl.
/// Uses RAII for curl handle management.
class HttpClient {
public:
    HttpClient(const std::string& base_url, TokenManager& token_manager);
    ~HttpClient();

    HttpClient(const HttpClient&) = delete;
    HttpClient& operator=(const HttpClient&) = delete;

    /// Perform a GET request. Returns parsed JSON.
    nlohmann::json get(const std::string& path, bool requires_auth = true);

    /// Perform a POST request with optional JSON body. Returns parsed JSON.
    nlohmann::json post(const std::string& path,
                        const nlohmann::json& body = nullptr,
                        bool requires_auth = true);

    /// Perform a PUT request with optional JSON body. Returns parsed JSON.
    nlohmann::json put(const std::string& path,
                       const nlohmann::json& body = nullptr,
                       bool requires_auth = true);

    /// Perform a PATCH request with optional JSON body. Returns parsed JSON.
    nlohmann::json patch(const std::string& path,
                         const nlohmann::json& body = nullptr,
                         bool requires_auth = true);

    /// Perform a DELETE request. Returns parsed JSON.
    nlohmann::json del(const std::string& path, bool requires_auth = true);

    /// Get the base URL.
    const std::string& base_url() const { return base_url_; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    std::string base_url_;
    TokenManager& token_manager_;

    /// Core request method.
    nlohmann::json request(const std::string& method,
                           const std::string& path,
                           const nlohmann::json& body,
                           bool requires_auth);

    /// Perform the raw HTTP call. Returns status code and response body.
    HttpResponse perform(const std::string& method,
                         const std::string& url,
                         const std::string& body_str,
                         const std::map<std::string, std::string>& headers);

    /// Map HTTP status code to the appropriate exception.
    [[noreturn]] void throw_for_status(long status,
                                       const std::string& body,
                                       const std::map<std::string, std::string>& headers);
};

} // namespace dominusnode
