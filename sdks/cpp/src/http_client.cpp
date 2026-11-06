// TokenManager, HttpClient (auth modes, 429/401 handling, error mapping) and the libcurl transport.
#include "dominusnode/http_client.hpp"
#include "dominusnode/constants.hpp"
#include "dominusnode/errors.hpp"
#include "dominusnode/secret.hpp"
#include "dominusnode/validation.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <chrono>
#include <random>
#include <thread>

namespace dominusnode {

// ─── TokenManager ───────────────────────────────────────────────────────────

void TokenManager::set_tokens(const std::string& access, const std::optional<std::string>& refresh) {
    std::lock_guard<std::mutex> l(mu_);
    if (access_) secure_zero_string(*access_);
    access_ = access;
    if (refresh && !refresh->empty()) {
        if (refresh_) secure_zero_string(*refresh_);
        refresh_ = refresh;
    }
    ++generation_;
}
void TokenManager::set_refresh_function(RefreshFn fn) { std::lock_guard<std::mutex> l(mu_); refresh_fn_ = std::move(fn); }
bool TokenManager::has_refresh_function() const { std::lock_guard<std::mutex> l(mu_); return static_cast<bool>(refresh_fn_); }
std::optional<std::string> TokenManager::access_token() const { std::lock_guard<std::mutex> l(mu_); return access_; }
std::optional<std::string> TokenManager::refresh_token() const { std::lock_guard<std::mutex> l(mu_); return refresh_; }
bool TokenManager::has_tokens() const { std::lock_guard<std::mutex> l(mu_); return access_.has_value() || refresh_.has_value(); }

static std::string b64url_decode(const std::string& in) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '-' || c == '+') return 62;
        if (c == '_' || c == '/') return 63;
        return -1;
    };
    std::string out;
    int buf = 0, bits = 0;
    for (char c : in) {
        if (c == '=') break;
        int v = val(c);
        if (v < 0) throw std::runtime_error("bad base64");
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += static_cast<char>((buf >> bits) & 0xFF);
        }
    }
    return out;
}

bool TokenManager::is_expired(const std::string& token) {
    try {
        auto d1 = token.find('.');
        auto d2 = d1 == std::string::npos ? d1 : token.find('.', d1 + 1);
        if (d2 == std::string::npos || token.find('.', d2 + 1) != std::string::npos) return true;
        auto payload = nlohmann::json::parse(b64url_decode(token.substr(d1 + 1, d2 - d1 - 1)));
        if (!payload.is_object() || !payload.contains("exp") || !payload["exp"].is_number()) return true;
        double exp_ms = payload["exp"].get<double>() * 1000.0;
        auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch()).count();
        return exp_ms < static_cast<double>(now_ms + TOKEN_REFRESH_BUFFER_MS);
    } catch (...) {
        return true;
    }
}

std::string TokenManager::get_valid_token() {
    {
        std::lock_guard<std::mutex> l(mu_);
        if (access_ && !is_expired(*access_)) return *access_;
    }
    return force_refresh();
}

std::string TokenManager::force_refresh() {
    unsigned long long seen;
    {
        std::lock_guard<std::mutex> l(mu_);
        seen = generation_;
    }
    std::lock_guard<std::mutex> single(refresh_mu_);  // singleton refresh
    RefreshFn fn;
    std::string rt;
    {
        std::lock_guard<std::mutex> l(mu_);
        if (generation_ != seen && access_) return *access_;  // another caller refreshed meanwhile
        if (!refresh_ || !refresh_fn_) throw AuthenticationError("No valid token and cannot refresh");
        fn = refresh_fn_;
        rt = *refresh_;
    }
    try {
        RefreshResult r = fn(rt);
        secure_zero_string(rt);
        set_tokens(r.access_token, r.refresh_token);
        return r.access_token;
    } catch (...) {
        secure_zero_string(rt);
        clear();  // a broken refresh must not loop
        throw;
    }
}

void TokenManager::clear() {
    std::lock_guard<std::mutex> l(mu_);
    if (access_) secure_zero_string(*access_);
    if (refresh_) secure_zero_string(*refresh_);
    access_.reset();
    refresh_.reset();
    ++generation_;
    // refresh_fn_ intentionally kept: reconnecting must keep working.
}

// ─── helpers ────────────────────────────────────────────────────────────────

long retry_delay_ms(long retry_after_seconds) {
    double base = std::min(static_cast<double>(std::max(retry_after_seconds, 0L)) * 1000.0,
                           static_cast<double>(MAX_RETRY_WAIT_MS));
    static thread_local std::mt19937 rng(std::random_device{}());
    std::uniform_real_distribution<double> dist(-0.5, 0.5);
    double v = base + base * 0.2 * dist(rng);
    return std::max(MIN_RETRY_WAIT_MS, static_cast<long>(v + 0.5));
}

void strip_dangerous_keys(nlohmann::json& j, int depth) {
    if (depth > 50) return;
    if (j.is_array()) {
        for (auto& v : j) strip_dangerous_keys(v, depth + 1);
    } else if (j.is_object()) {
        for (const char* k : {"__proto__", "constructor", "prototype"}) j.erase(k);
        for (auto& [k, v] : j.items()) {
            (void)k;
            strip_dangerous_keys(v, depth + 1);
        }
    }
}

static nlohmann::json safe_parse(const std::string& text) {
    auto j = nlohmann::json::parse(text);
    strip_dangerous_keys(j);
    return j;
}

static long parse_retry_after(const std::map<std::string, std::string>& h, long fallback) {
    auto it = h.find("retry-after");
    if (it == h.end()) return fallback;
    try {
        std::size_t pos = 0;
        long n = std::stol(it->second, &pos);
        return n >= 0 ? n : fallback;
    } catch (...) {
        return fallback;
    }
}

[[noreturn]] static void throw_for_status(long status, const std::string& body,
                                          const std::map<std::string, std::string>& headers) {
    std::string message = body;
    std::optional<std::string> code;
    Details details;
    try {
        auto p = safe_parse(body);
        if (p.is_object()) {
            if (p.contains("error") && p["error"].is_string()) message = p["error"].get<std::string>();
            else if (p.contains("message") && p["message"].is_string()) message = p["message"].get<std::string>();
            if (p.contains("code") && p["code"].is_string()) code = p["code"].get<std::string>();
            else if (p.contains("mfaRequired") && p["mfaRequired"] == true) code = "MFA_REQUIRED";
            for (const char* k : {"max", "cap", "limitPerDay"}) {
                if (p.contains(k) && (p[k].is_number() || p[k].is_string())) details[k] = p[k];
            }
        }
    } catch (...) {
    }
    if (message.empty()) message = "HTTP " + std::to_string(status);
    if (message.size() > 500) message = message.substr(0, 500) + "... [truncated]";
    switch (status) {
        case 400: throw ValidationError(message, 400, code, details);
        case 401: throw AuthenticationError(message, code, details);
        case 402: throw InsufficientBalanceError(message, code, details);
        case 403: throw AuthorizationError(message, code, details);
        case 404: throw NotFoundError(message, code, details);
        case 409: throw ConflictError(message, code, details);
        case 429: throw RateLimitError(message, static_cast<int>(parse_retry_after(headers, 60)), code, details);
        default:
            if (status >= 500) throw ServerError(message, static_cast<int>(status), code, details);
            throw DominusNodeError(message, static_cast<int>(status), code, details);
    }
}

// ─── HttpClient ─────────────────────────────────────────────────────────────

HttpClient::HttpClient(const std::string& base_url, TokenManager& tokens,
                       std::function<std::string()> api_key, Transport transport)
    : tokens_(tokens), api_key_(std::move(api_key)), transport_(std::move(transport)) {
    CURLU* u = curl_url();
    bool ok = u && curl_url_set(u, CURLUPART_URL, base_url.c_str(), CURLU_NON_SUPPORT_SCHEME) == CURLUE_OK;
    std::string scheme;
    bool userinfo = false;
    if (ok) {
        char* v = nullptr;
        if (curl_url_get(u, CURLUPART_SCHEME, &v, 0) == CURLUE_OK && v) { scheme = v; curl_free(v); }
        v = nullptr;
        if (curl_url_get(u, CURLUPART_USER, &v, 0) == CURLUE_OK && v) { userinfo = true; curl_free(v); }
        v = nullptr;
        if (curl_url_get(u, CURLUPART_PASSWORD, &v, 0) == CURLUE_OK && v) { userinfo = true; curl_free(v); }
    }
    curl_url_cleanup(u);
    if (!ok) throw invalid_arg("baseUrl is not a valid URL");
    if (scheme != "http" && scheme != "https") throw invalid_arg("baseUrl must be http(s)");
    if (userinfo) throw invalid_arg("baseUrl must not contain credentials");
    base_url_ = base_url;
    while (!base_url_.empty() && base_url_.back() == '/') base_url_.pop_back();
    if (!transport_) transport_ = make_curl_transport();
    sleeper_ = [](long ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); };
}

std::string HttpClient::bearer(AuthMode mode, bool force) {
    if (mode == AuthMode::None) return "";
    if (mode == AuthMode::Agent) {
        std::string k = api_key_ ? api_key_() : "";
        if (!k.empty()) return k;
    }
    if (!tokens_.has_tokens()) {
        throw AuthenticationError("Not authenticated. Call connect_with_key() or wallet_auth.verify() first.");
    }
    return force ? tokens_.force_refresh() : tokens_.get_valid_token();
}

HttpResponse HttpClient::send(const std::string& method, const std::string& path,
                              const std::optional<nlohmann::json>& body, const std::string& bearer_token,
                              const std::vector<std::pair<std::string, std::string>>& headers) {
    HttpRequest req;
    req.method = method;
    req.url = base_url_ + path;
    req.timeout_ms = REQUEST_TIMEOUT_MS;
    req.headers.emplace_back("User-Agent", USER_AGENT);
    req.headers.emplace_back("Accept", "application/json");
    for (const auto& h : headers) req.headers.push_back(h);
    if (body) {
        req.headers.emplace_back("Content-Type", "application/json");
        req.body = body->dump();
    }
    if (!bearer_token.empty()) req.headers.emplace_back("Authorization", "Bearer " + bearer_token);
    try {
        HttpResponse r = transport_(req);
        for (auto& h : req.headers) if (h.first == "Authorization") secure_zero_string(h.second);
        return r;
    } catch (const DominusNodeError&) {
        throw;
    } catch (const std::exception& e) {
        throw NetworkError(std::string("Network request failed: ") + e.what());
    }
}

std::string HttpClient::request_raw(const std::string& method, const std::string& path,
                                    const std::optional<nlohmann::json>& body, AuthMode auth,
                                    const std::vector<std::pair<std::string, std::string>>& headers) {
    std::string tok = bearer(auth, false);
    HttpResponse res = send(method, path, body, tok, headers);

    for (int i = 0; i < MAX_RATE_LIMIT_RETRIES && res.status == 429; ++i) {
        long wait = retry_delay_ms(parse_retry_after(res.headers, 5));
        res.body.clear();  // the 429 body is never used
        sleeper_(wait);
        tok = bearer(auth, false);
        res = send(method, path, body, tok, headers);
    }

    bool used_jwt = !tok.empty() && tok.rfind("dn_", 0) != 0;
    if (res.status == 401 && used_jwt && tokens_.refresh_token()) {
        std::string refreshed;
        try {
            refreshed = bearer(auth, true);
        } catch (...) {
            refreshed.clear();
        }
        if (refreshed.empty()) throw AuthenticationError("Session expired and token refresh failed");
        res = send(method, path, body, refreshed, headers);
        secure_zero_string(refreshed);
    }
    secure_zero_string(tok);

    auto cl = res.headers.find("content-length");
    if (cl != res.headers.end()) {
        try {
            if (std::stoull(cl->second) > MAX_RESPONSE_BYTES) {
                throw ServerError("Response body too large", static_cast<int>(res.status));
            }
        } catch (const ServerError&) {
            throw;
        } catch (...) {
        }
    }
    if (res.body.size() > MAX_RESPONSE_BYTES) {
        throw ServerError("Response body exceeds size limit", static_cast<int>(res.status));
    }
    if (res.status < 200 || res.status >= 300) throw_for_status(res.status, res.body, res.headers);
    return std::move(res.body);
}

nlohmann::json HttpClient::request(const std::string& method, const std::string& path,
                                   const std::optional<nlohmann::json>& body, AuthMode auth,
                                   const std::vector<std::pair<std::string, std::string>>& headers) {
    std::string text = request_raw(method, path, body, auth, headers);
    if (text.empty()) return nlohmann::json::object();
    try {
        return safe_parse(text);
    } catch (...) {
        throw ServerError("Invalid JSON in response", 200);
    }
}

nlohmann::json HttpClient::get(const std::string& path, AuthMode auth) { return request("GET", path, std::nullopt, auth); }
nlohmann::json HttpClient::post(const std::string& path, const nlohmann::json& body, AuthMode auth,
                                const std::vector<std::pair<std::string, std::string>>& headers) {
    return request("POST", path, std::optional<nlohmann::json>(body), auth, headers);
}
nlohmann::json HttpClient::put(const std::string& path, const nlohmann::json& body, AuthMode auth) {
    return request("PUT", path, std::optional<nlohmann::json>(body), auth);
}
nlohmann::json HttpClient::patch(const std::string& path, const nlohmann::json& body, AuthMode auth) {
    return request("PATCH", path, std::optional<nlohmann::json>(body), auth);
}
nlohmann::json HttpClient::del(const std::string& path, AuthMode auth) { return request("DELETE", path, std::nullopt, auth); }

// ─── libcurl transport ──────────────────────────────────────────────────────

namespace {

struct CurlGlobal {
    CurlGlobal() { curl_global_init(CURL_GLOBAL_DEFAULT); }
};

struct Capture {
    CURL* curl = nullptr;
    HttpResponse* res = nullptr;
    bool too_large = false;
    bool skipped_429 = false;
};

std::string trim(const std::string& s) {
    auto b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    auto e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

size_t header_cb(char* buf, size_t size, size_t n, void* ud) {
    auto* c = static_cast<Capture*>(ud);
    size_t total = size * n;
    std::string line(buf, total);
    if (line.rfind("HTTP/", 0) == 0) {
        c->res->headers.clear();
        return total;
    }
    auto colon = line.find(':');
    if (colon != std::string::npos) {
        std::string k = to_lower(line.substr(0, colon));
        std::string v = trim(line.substr(colon + 1));
        if (k == "content-length") {
            try {
                if (std::stoull(v) > MAX_RESPONSE_BYTES) {
                    c->too_large = true;
                    return 0;  // abort: do not download an oversize body
                }
            } catch (...) {
            }
        }
        c->res->headers[k] = v;
    }
    return total;
}

size_t write_cb(char* ptr, size_t size, size_t n, void* ud) {
    auto* c = static_cast<Capture*>(ud);
    if (n != 0 && (size * n) / n != size) return 0;
    size_t total = size * n;
    long code = 0;
    curl_easy_getinfo(c->curl, CURLINFO_RESPONSE_CODE, &code);
    if (code == 429) {  // cancel the 429 body without reading it
        c->skipped_429 = true;
        return 0;
    }
    if (c->res->body.size() + total > MAX_RESPONSE_BYTES) {
        c->too_large = true;
        return 0;
    }
    c->res->body.append(ptr, total);
    return total;
}

}  // namespace

Transport make_curl_transport() {
    static CurlGlobal init;
    struct State {
        std::mutex mu;
        CURL* curl = curl_easy_init();
        ~State() { if (curl) curl_easy_cleanup(curl); }
    };
    auto st = std::make_shared<State>();
    if (!st->curl) throw NetworkError("Failed to initialize libcurl");
    return [st](const HttpRequest& req) -> HttpResponse {
        std::lock_guard<std::mutex> lock(st->mu);
        CURL* curl = st->curl;
        HttpResponse res;
        Capture cap{curl, &res};

        curl_easy_reset(curl);
        // Security options MUST be re-applied after every curl_easy_reset().
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(curl, CURLOPT_SSLVERSION, static_cast<long>(CURL_SSLVERSION_TLSv1_2));
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

        curl_easy_setopt(curl, CURLOPT_URL, req.url.c_str());
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, req.timeout_ms);
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, std::min(req.timeout_ms, 10000L));
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &cap);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_cb);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &cap);
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, req.method.c_str());
        if (req.body) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, req.body->c_str());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(req.body->size()));
        }
        struct curl_slist* hl = nullptr;
        for (const auto& [k, v] : req.headers) {
            std::string line = k + ": " + v;
            hl = curl_slist_append(hl, line.c_str());
            secure_zero_string(line);
        }
        hl = curl_slist_append(hl, "Expect:");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hl);

        CURLcode rc = curl_easy_perform(curl);
        curl_slist_free_all(hl);
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &res.status);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, nullptr);

        if (cap.too_large) throw ServerError("Response body too large", static_cast<int>(res.status));
        if (rc != CURLE_OK && !(cap.skipped_429 && rc == CURLE_WRITE_ERROR)) {
            throw NetworkError(std::string("Network request failed: ") + curl_easy_strerror(rc));
        }
        return res;
    };
}

}  // namespace dominusnode
