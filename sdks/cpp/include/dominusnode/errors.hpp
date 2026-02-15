#pragma once

#include <stdexcept>
#include <string>

namespace dominusnode {

/// Base error for all Dominus Node SDK errors.
class DominusNodeError : public std::runtime_error {
public:
    explicit DominusNodeError(const std::string& msg, int status = 0)
        : std::runtime_error(msg), status_code_(status) {}

    int status_code() const noexcept { return status_code_; }

private:
    int status_code_;
};

/// HTTP 401 - Authentication failed.
class AuthenticationError : public DominusNodeError {
public:
    explicit AuthenticationError(const std::string& msg = "Authentication failed")
        : DominusNodeError(msg, 401) {}
};

/// HTTP 403 - Access denied.
class AuthorizationError : public DominusNodeError {
public:
    explicit AuthorizationError(const std::string& msg = "Access denied")
        : DominusNodeError(msg, 403) {}
};

/// HTTP 429 - Rate limit exceeded.
class RateLimitError : public DominusNodeError {
public:
    explicit RateLimitError(const std::string& msg = "Rate limit exceeded", int retry_after = 60)
        : DominusNodeError(msg, 429), retry_after_(retry_after) {}

    int retry_after_seconds() const noexcept { return retry_after_; }

private:
    int retry_after_;
};

/// HTTP 402 - Insufficient balance for operation.
class InsufficientBalanceError : public DominusNodeError {
public:
    explicit InsufficientBalanceError(const std::string& msg = "Insufficient balance")
        : DominusNodeError(msg, 402) {}
};

/// HTTP 400 - Validation failed.
class ValidationError : public DominusNodeError {
public:
    explicit ValidationError(const std::string& msg = "Validation failed")
        : DominusNodeError(msg, 400) {}
};

/// HTTP 404 - Resource not found.
class NotFoundError : public DominusNodeError {
public:
    explicit NotFoundError(const std::string& msg = "Resource not found")
        : DominusNodeError(msg, 404) {}
};

/// HTTP 409 - Resource conflict (e.g. duplicate email).
class ConflictError : public DominusNodeError {
public:
    explicit ConflictError(const std::string& msg = "Resource conflict")
        : DominusNodeError(msg, 409) {}
};

/// HTTP 5xx - Server-side error.
class ServerError : public DominusNodeError {
public:
    explicit ServerError(const std::string& msg = "Server error")
        : DominusNodeError(msg, 500) {}
};

/// Network-level error (DNS, timeout, connection refused).
class NetworkError : public DominusNodeError {
public:
    explicit NetworkError(const std::string& msg = "Network error")
        : DominusNodeError(msg, 0) {}
};

/// Proxy-specific error (tunnel failure, upstream error).
class ProxyError : public DominusNodeError {
public:
    explicit ProxyError(const std::string& msg, const std::string& proxy_error_code = "")
        : DominusNodeError(msg, 0), proxy_error_code_(proxy_error_code) {}

    const std::string& proxy_error_code() const noexcept { return proxy_error_code_; }

private:
    std::string proxy_error_code_;
};

} // namespace dominusnode
