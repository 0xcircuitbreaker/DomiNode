#pragma once

#include <stdexcept>
#include <string>

namespace dominode {

/// Base error for all DomiNode SDK errors.
class DomiNodeError : public std::runtime_error {
public:
    explicit DomiNodeError(const std::string& msg, int status = 0)
        : std::runtime_error(msg), status_code_(status) {}

    int status_code() const noexcept { return status_code_; }

private:
    int status_code_;
};

/// HTTP 401 - Authentication failed.
class AuthenticationError : public DomiNodeError {
public:
    explicit AuthenticationError(const std::string& msg = "Authentication failed")
        : DomiNodeError(msg, 401) {}
};

/// HTTP 403 - Access denied.
class AuthorizationError : public DomiNodeError {
public:
    explicit AuthorizationError(const std::string& msg = "Access denied")
        : DomiNodeError(msg, 403) {}
};

/// HTTP 429 - Rate limit exceeded.
class RateLimitError : public DomiNodeError {
public:
    explicit RateLimitError(const std::string& msg = "Rate limit exceeded", int retry_after = 60)
        : DomiNodeError(msg, 429), retry_after_(retry_after) {}

    int retry_after_seconds() const noexcept { return retry_after_; }

private:
    int retry_after_;
};

/// HTTP 402 - Insufficient balance for operation.
class InsufficientBalanceError : public DomiNodeError {
public:
    explicit InsufficientBalanceError(const std::string& msg = "Insufficient balance")
        : DomiNodeError(msg, 402) {}
};

/// HTTP 400 - Validation failed.
class ValidationError : public DomiNodeError {
public:
    explicit ValidationError(const std::string& msg = "Validation failed")
        : DomiNodeError(msg, 400) {}
};

/// HTTP 404 - Resource not found.
class NotFoundError : public DomiNodeError {
public:
    explicit NotFoundError(const std::string& msg = "Resource not found")
        : DomiNodeError(msg, 404) {}
};

/// HTTP 409 - Resource conflict (e.g. duplicate email).
class ConflictError : public DomiNodeError {
public:
    explicit ConflictError(const std::string& msg = "Resource conflict")
        : DomiNodeError(msg, 409) {}
};

/// HTTP 5xx - Server-side error.
class ServerError : public DomiNodeError {
public:
    explicit ServerError(const std::string& msg = "Server error")
        : DomiNodeError(msg, 500) {}
};

/// Network-level error (DNS, timeout, connection refused).
class NetworkError : public DomiNodeError {
public:
    explicit NetworkError(const std::string& msg = "Network error")
        : DomiNodeError(msg, 0) {}
};

/// Proxy-specific error (tunnel failure, upstream error).
class ProxyError : public DomiNodeError {
public:
    explicit ProxyError(const std::string& msg, const std::string& proxy_error_code = "")
        : DomiNodeError(msg, 0), proxy_error_code_(proxy_error_code) {}

    const std::string& proxy_error_code() const noexcept { return proxy_error_code_; }

private:
    std::string proxy_error_code_;
};

} // namespace dominode
