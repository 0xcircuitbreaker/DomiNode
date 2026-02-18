#include "dominusnode/http_client.hpp"
#include "dominusnode/token_manager.hpp"
#include "dominusnode/constants.hpp"
#include "dominusnode/errors.hpp"

#include <curl/curl.h>
#include <algorithm>
#include <cctype>
#include <mutex>
#include <sstream>
#include <thread>
#include <chrono>
#include <random>

namespace dominusnode {

// ─── Pimpl holding the CURL handle ──────────────────────────────────────────

struct HttpClient::Impl {
    CURL* curl = nullptr;
    std::mutex curl_mutex;

    Impl() {
        curl = curl_easy_init();
        if (!curl) {
            throw NetworkError("Failed to initialize libcurl");
        }
    }

    ~Impl() {
        if (curl) {
            curl_easy_cleanup(curl);
        }
    }
};

// ─── libcurl callbacks ─────────────────────────────────────────────────────

static size_t write_callback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* response = static_cast<std::string*>(userdata);
    size_t total = size * nmemb;
    // Guard against size_t overflow in multiplication
    if (nmemb != 0 && total / nmemb != size) return 0;
    // R19 C-2: Cap response body to 10MB (consistent with all other SDKs)
    static constexpr size_t MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
    if (response->size() + total > MAX_RESPONSE_SIZE) return 0;
    response->append(ptr, total);
    return total;
}

static size_t header_callback(char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* headers = static_cast<std::map<std::string, std::string>*>(userdata);
    size_t total = size * nitems;
    std::string line(buffer, total);

    auto colon = line.find(':');
    if (colon != std::string::npos) {
        std::string key = line.substr(0, colon);
        std::string value = line.substr(colon + 1);

        // Trim whitespace
        auto ltrim = [](std::string& s) {
            s.erase(s.begin(), std::find_if(s.begin(), s.end(),
                [](unsigned char ch) { return !std::isspace(ch); }));
        };
        auto rtrim = [](std::string& s) {
            s.erase(std::find_if(s.rbegin(), s.rend(),
                [](unsigned char ch) { return !std::isspace(ch); }).base(), s.end());
        };

        // Lowercase the key for case-insensitive lookup
        std::transform(key.begin(), key.end(), key.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        ltrim(value);
        rtrim(value);

        (*headers)[key] = value;
    }

    return total;
}

// ─── HttpClient implementation ──────────────────────────────────────────────

HttpClient::HttpClient(const std::string& base_url, TokenManager& token_manager)
    : impl_(std::make_unique<Impl>())
    , base_url_(base_url)
    , token_manager_(token_manager) {
    // Strip trailing slash from base URL
    while (!base_url_.empty() && base_url_.back() == '/') {
        base_url_.pop_back();
    }
}

HttpClient::~HttpClient() = default;

HttpResponse HttpClient::perform(const std::string& method,
                                  const std::string& url,
                                  const std::string& body_str,
                                  const std::map<std::string, std::string>& headers) {
    std::lock_guard<std::mutex> lock(impl_->curl_mutex);
    CURL* curl = impl_->curl;
    HttpResponse response;

    curl_easy_reset(curl);
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);

    // Enforce TLS verification (explicit after curl_easy_reset clears all options)
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    // R16 C-2: Enforce TLS 1.2 minimum to prevent weak cipher negotiation on old systems
    curl_easy_setopt(curl, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
    // R16 C-4: Disable automatic redirects to prevent credential leakage via HTTPS→HTTP redirects
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
    // Restrict to HTTPS only by default to prevent redirect-based token leakage.
    // Allow HTTP for local development (localhost / 127.0.0.1).
    if (base_url_.rfind("http://localhost", 0) == 0 || base_url_.rfind("http://127.0.0.1", 0) == 0) {
        curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS | CURLPROTO_HTTP);
    } else {
        curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    }

    // Set HTTP method
    if (method == "POST") {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
    } else if (method == "PUT") {
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
    } else if (method == "DELETE") {
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
    }
    // GET is the default

    // Set request body for POST/PUT
    if (!body_str.empty() && (method == "POST" || method == "PUT")) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_str.c_str());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body_str.size()));
    } else if (method == "POST") {
        // POST with no body
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "");
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, 0L);
    }

    // Build header list
    struct curl_slist* header_list = nullptr;
    for (const auto& [key, value] : headers) {
        std::string header_line = key + ": " + value;
        header_list = curl_slist_append(header_list, header_line.c_str());
    }
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, header_list);

    CURLcode res = curl_easy_perform(curl);

    curl_slist_free_all(header_list);

    if (res != CURLE_OK) {
        throw NetworkError(std::string("Network request failed: ") + curl_easy_strerror(res));
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    return response;
}

void HttpClient::throw_for_status(long status,
                                   const std::string& body,
                                   const std::map<std::string, std::string>& headers) {
    std::string message;
    try {
        auto parsed = nlohmann::json::parse(body);
        if (parsed.contains("error") && parsed["error"].is_string()) {
            message = parsed["error"].get<std::string>();
        } else if (parsed.contains("message") && parsed["message"].is_string()) {
            message = parsed["message"].get<std::string>();
        } else {
            message = body;
        }
    } catch (...) {
        message = body.empty() ? "Unknown error" : body;
    }
    // R27 H-1: Truncate error message to prevent unbounded body in exception strings
    if (message.size() > 500) {
        message = message.substr(0, 500) + "... [truncated]";
    }

    switch (status) {
        case 400: throw ValidationError(message);
        case 401: throw AuthenticationError(message);
        case 402: throw InsufficientBalanceError(message);
        case 403: throw AuthorizationError(message);
        case 404: throw NotFoundError(message);
        case 409: throw ConflictError(message);
        case 429: {
            int retry_after = 60;
            auto it = headers.find("retry-after");
            if (it != headers.end()) {
                try { retry_after = std::stoi(it->second); } catch (...) {}
            }
            throw RateLimitError(message, retry_after);
        }
        default:
            if (status >= 500) throw ServerError(message);
            throw DominusNodeError(message, static_cast<int>(status));
    }
}

nlohmann::json HttpClient::request(const std::string& method,
                                    const std::string& path,
                                    const nlohmann::json& body,
                                    bool requires_auth) {
    std::map<std::string, std::string> headers;
    headers["User-Agent"] = USER_AGENT;
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "application/json";

    if (requires_auth) {
        std::string token = token_manager_.get_valid_token();
        headers["Authorization"] = "Bearer " + token;
    }

    std::string url = base_url_ + path;
    std::string body_str;
    if (!body.is_null()) {
        body_str = body.dump();
    }

    HttpResponse resp = perform(method, url, body_str, headers);

    // Auto-retry once on 429 rate limit
    if (resp.status_code == 429) {
        int retry_after = 60;
        auto it = resp.headers.find("retry-after");
        if (it != resp.headers.end()) {
            try { retry_after = std::stoi(it->second); } catch (...) {}
        }
        int wait_ms = std::max(100, std::min(retry_after * 1000, 10000));
        // R23 C-1: Thread-safe RNG for jitter (replaces non-thread-safe std::rand)
        static thread_local std::mt19937 rng(std::random_device{}());
        std::uniform_real_distribution<double> dist(-0.5, 0.5);
        int jitter = static_cast<int>(wait_ms * 0.2 * dist(rng));
        wait_ms = std::max(100, wait_ms + jitter);
        std::this_thread::sleep_for(std::chrono::milliseconds(wait_ms));

        // R17: Refresh token after wait in case it expired during the sleep
        if (requires_auth) {
            std::string fresh_token = token_manager_.get_valid_token();
            headers["Authorization"] = "Bearer " + fresh_token;
        }
        resp = perform(method, url, body_str, headers);
    }

    // Auto-retry once on 401 with forced token refresh
    if (resp.status_code == 401 && requires_auth) {
        try {
            std::string new_token = token_manager_.force_refresh();
            headers["Authorization"] = "Bearer " + new_token;
            HttpResponse retry_resp = perform(method, url, body_str, headers);
            if (retry_resp.status_code >= 200 && retry_resp.status_code < 300) {
                if (retry_resp.body.empty()) return nlohmann::json::object();
                return nlohmann::json::parse(retry_resp.body);
            }
            throw_for_status(retry_resp.status_code, retry_resp.body, retry_resp.headers);
        } catch (const AuthenticationError&) {
            throw;
        } catch (...) {
            // Refresh or retry failed — fall through to original 401 handling
        }
    }

    if (resp.status_code < 200 || resp.status_code >= 300) {
        throw_for_status(resp.status_code, resp.body, resp.headers);
    }

    if (resp.body.empty()) return nlohmann::json::object();
    return nlohmann::json::parse(resp.body);
}

nlohmann::json HttpClient::get(const std::string& path, bool requires_auth) {
    return request("GET", path, nullptr, requires_auth);
}

nlohmann::json HttpClient::post(const std::string& path,
                                 const nlohmann::json& body,
                                 bool requires_auth) {
    return request("POST", path, body.is_null() ? nlohmann::json::object() : body, requires_auth);
}

nlohmann::json HttpClient::put(const std::string& path,
                                const nlohmann::json& body,
                                bool requires_auth) {
    return request("PUT", path, body.is_null() ? nlohmann::json::object() : body, requires_auth);
}

nlohmann::json HttpClient::del(const std::string& path, bool requires_auth) {
    return request("DELETE", path, nullptr, requires_auth);
}

} // namespace dominusnode
