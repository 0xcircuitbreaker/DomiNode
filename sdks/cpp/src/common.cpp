// Errors, credential scrubbing, Secret zeroization and argument validation.
#include "dominusnode/constants.hpp"
#include "dominusnode/errors.hpp"
#include "dominusnode/secret.hpp"
#include "dominusnode/validation.hpp"

#include <openssl/rand.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <regex>

namespace dominusnode {

// ─── Errors ─────────────────────────────────────────────────────────────────

std::string scrub_credentials(const std::string& message) {
    static const std::regex key_re("dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+");
    static const std::regex jwt_re("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*");
    std::string out = std::regex_replace(message, key_re, REDACTED);
    return std::regex_replace(out, jwt_re, REDACTED);
}

DominusNodeError::DominusNodeError(const std::string& message, std::optional<int> status_code,
                                   std::optional<std::string> code, std::map<std::string, nlohmann::json> details)
    : std::runtime_error(scrub_credentials(message)),
      status_code_(status_code), code_(std::move(code)), details_(std::move(details)) {}

ValidationError invalid_arg(const std::string& message) {
    return ValidationError(message, std::nullopt, std::string("INVALID_ARGUMENT"));
}

// ─── Secret ─────────────────────────────────────────────────────────────────

void secure_zero_string(std::string& s) noexcept {
    if (!s.empty()) {
        volatile char* p = &s[0];
        for (std::size_t i = 0; i < s.size(); ++i) p[i] = 0;
    }
    s.clear();
}

// ─── Validation ─────────────────────────────────────────────────────────────

namespace {
const std::regex& eth_re() { static const std::regex r("^0x[0-9a-fA-F]{40}$"); return r; }
const std::regex& sig_re() { static const std::regex r("^0x[0-9a-fA-F]{130}$"); return r; }
const std::regex& uuid_re() {
    static const std::regex r("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    return r;
}
}  // namespace

bool is_eth_address(const std::string& s) { return std::regex_match(s, eth_re()); }
bool is_uuid(const std::string& s) { return std::regex_match(s, uuid_re()); }
bool is_hex64(const std::string& s) {
    static const std::regex r("^[0-9a-f]{64}$");
    return std::regex_match(s, r);
}

std::string validate_address(const std::string& address, const std::string& name) {
    if (!is_eth_address(address)) throw invalid_arg(name + " must be an Ethereum address (0x followed by 40 hex characters)");
    return address;
}

std::string validate_signature(const std::string& signature, const std::string& name) {
    if (signature.size() > 200) throw invalid_arg(name + " must not exceed 200 characters");
    if (!std::regex_match(signature, sig_re())) throw invalid_arg(name + " must be an EIP-191 signature (0x followed by 130 hex characters)");
    return signature;
}

std::int64_t validate_cents(std::int64_t cents, const std::string& name, bool allow_zero) {
    bool ok = (allow_zero ? cents >= 0 : cents > 0) && cents <= MAX_AMOUNT_CENTS;
    if (!ok) throw invalid_arg(name + " must be an integer " + (allow_zero ? ">= 0" : "> 0") + " and <= 2147483647");
    return cents;
}

std::string validate_idempotency_key(const std::string& key) {
    static const std::regex r("^[A-Za-z0-9_-]{8,120}$");
    if (!std::regex_match(key, r)) throw invalid_arg("idempotencyKey must be 8-120 characters of [A-Za-z0-9_-]");
    return key;
}

std::string validate_uuid(const std::string& v, const std::string& name) {
    if (!is_uuid(v)) throw invalid_arg(name + " must be a UUID");
    return v;
}

std::string validate_non_empty(const std::string& v, const std::string& name, std::size_t max) {
    if (v.empty() || v.size() > max) throw invalid_arg(name + " must be a non-empty string (max " + std::to_string(max) + ")");
    return v;
}

long long validate_int_range(long long v, const std::string& name, long long min, long long max) {
    if (v < min || v > max) {
        throw invalid_arg(name + " must be an integer in [" + std::to_string(min) + ", " + std::to_string(max) + "]");
    }
    return v;
}

std::string validate_api_key(const std::string& key) {
    static const std::regex r("^dn_(live|test)_[A-Za-z0-9_-]{8,200}$");
    if (!std::regex_match(key, r)) throw invalid_arg("apiKey must be a dn_live_ or dn_test_ key");
    return key;
}

std::string MusdInput::normalize(std::uint64_t min, std::uint64_t max, const std::string& name) const {
    std::uint64_t n = 0;
    static const std::regex r("^[1-9][0-9]{0,15}$");
    if (kind_ == Kind::Int) {
        n = u_;
    } else if (kind_ == Kind::Str && std::regex_match(s_, r)) {
        n = std::stoull(s_);
    } else {
        throw invalid_arg(name + " must be a positive integer number of µUSD (integer or digit string)");
    }
    if (n < min || n > max) {
        throw invalid_arg(name + " must be between " + std::to_string(min) + " and " + std::to_string(max) + " µUSD");
    }
    return std::to_string(n);
}

std::string uuid_v4() {
    unsigned char b[16];
    if (RAND_bytes(b, sizeof b) != 1) throw DominusNodeError("random number generator failure");
    b[6] = static_cast<unsigned char>((b[6] & 0x0f) | 0x40);
    b[8] = static_cast<unsigned char>((b[8] & 0x3f) | 0x80);
    char out[37];
    std::snprintf(out, sizeof out, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                  b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return out;
}

std::string new_idempotency_key() { return "dn-" + uuid_v4(); }

std::string url_encode(const std::string& v) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : v) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' ||
            c == '\'' || c == '(' || c == ')') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

namespace {
// application/x-www-form-urlencoded (URLSearchParams semantics).
std::string form_encode(const std::string& v) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : v) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '*') out += static_cast<char>(c);
        else if (c == ' ') out += '+';
        else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return out;
}
}  // namespace

Query& Query::add(const std::string& k, const std::optional<std::string>& v) {
    if (v) items_.emplace_back(k, *v);
    return *this;
}
Query& Query::add(const std::string& k, const std::optional<long long>& v) {
    if (v) items_.emplace_back(k, std::to_string(*v));
    return *this;
}
Query& Query::add(const std::string& k, const std::optional<int>& v) {
    if (v) items_.emplace_back(k, std::to_string(*v));
    return *this;
}
std::string Query::str() const {
    std::string s;
    for (const auto& [k, v] : items_) s += (s.empty() ? "?" : "&") + form_encode(k) + "=" + form_encode(v);
    return s;
}

std::string to_lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}
std::string to_upper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

}  // namespace dominusnode
