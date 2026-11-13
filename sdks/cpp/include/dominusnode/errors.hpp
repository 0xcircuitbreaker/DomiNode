#pragma once

#include <nlohmann/json.hpp>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>

namespace dominusnode {

/// Replace dn_live_/dn_test_/dn_node_/dn_proxy_ keys and JWTs with "[REDACTED]".
std::string scrub_credentials(const std::string& message);

/// Base error. Every message passes through scrub_credentials().
class DominusNodeError : public std::runtime_error {
public:
    explicit DominusNodeError(const std::string& message,
                              std::optional<int> status_code = std::nullopt,
                              std::optional<std::string> code = std::nullopt,
                              std::map<std::string, nlohmann::json> details = {});

    /// HTTP status (nullopt for client-side / transport errors).
    const std::optional<int>& status_code() const noexcept { return status_code_; }
    /// Server error code (body `code`), e.g. "INVALID_CHALLENGE"; "INVALID_ARGUMENT" for client checks.
    const std::optional<std::string>& code() const noexcept { return code_; }
    /// Numeric/string fields `max`, `cap`, `limitPerDay` from the error body.
    const std::map<std::string, nlohmann::json>& details() const noexcept { return details_; }

private:
    std::optional<int> status_code_;
    std::optional<std::string> code_;
    std::map<std::string, nlohmann::json> details_;
};

using Details = std::map<std::string, nlohmann::json>;
using OptCode = std::optional<std::string>;

/// HTTP 400, or a client-side argument check (status nullopt, code INVALID_ARGUMENT; no request sent).
class ValidationError : public DominusNodeError {
public:
    explicit ValidationError(const std::string& m = "Validation failed", std::optional<int> s = 400,
                             OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, s, std::move(c), std::move(d)) {}
};
class AuthenticationError : public DominusNodeError {
public:
    explicit AuthenticationError(const std::string& m = "Authentication failed", OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, 401, std::move(c), std::move(d)) {}
};
class InsufficientBalanceError : public DominusNodeError {
public:
    explicit InsufficientBalanceError(const std::string& m = "Insufficient balance", OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, 402, std::move(c), std::move(d)) {}
};
class AuthorizationError : public DominusNodeError {
public:
    explicit AuthorizationError(const std::string& m = "Access denied", OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, 403, std::move(c), std::move(d)) {}
};
class NotFoundError : public DominusNodeError {
public:
    explicit NotFoundError(const std::string& m = "Resource not found", OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, 404, std::move(c), std::move(d)) {}
};
class ConflictError : public DominusNodeError {
public:
    explicit ConflictError(const std::string& m = "Resource conflict", OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, 409, std::move(c), std::move(d)) {}
};
class RateLimitError : public DominusNodeError {
public:
    explicit RateLimitError(const std::string& m = "Rate limit exceeded", int retry_after_seconds = 60,
                            OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, 429, std::move(c), std::move(d)), retry_after_seconds_(retry_after_seconds) {}
    int retry_after_seconds() const noexcept { return retry_after_seconds_; }
private:
    int retry_after_seconds_;
};
/// >= 500, oversize body, invalid JSON.
class ServerError : public DominusNodeError {
public:
    explicit ServerError(const std::string& m = "Server error", int status = 500, OptCode c = std::nullopt, Details d = {})
        : DominusNodeError(m, status, std::move(c), std::move(d)) {}
};
/// Transport failure.
class NetworkError : public DominusNodeError {
public:
    explicit NetworkError(const std::string& m = "Network error") : DominusNodeError(m) {}
};
/// Server data the SDK refuses to act on (message mismatch, bad challenge, bad node key) or a signer failure.
class ProtocolError : public DominusNodeError {
public:
    explicit ProtocolError(const std::string& m) : DominusNodeError(m) {}
};
/// proxy.fetch() failure: blocked target, refused tunnel (status_code), timeout.
class ProxyError : public DominusNodeError {
public:
    explicit ProxyError(const std::string& m, std::optional<int> status = std::nullopt) : DominusNodeError(m, status) {}
    /// Refused CONNECT (2.2): code() = X-DominusNode-Error, details()["retryAfter"] = Retry-After seconds.
    ProxyError(const std::string& m, std::optional<int> status, std::optional<std::string> code,
               std::map<std::string, nlohmann::json> details)
        : DominusNodeError(m, status, std::move(code), std::move(details)) {}
};

/// Client-side argument validation failure (no request sent).
ValidationError invalid_arg(const std::string& message);

} // namespace dominusnode
