"""DomiNode SDK error hierarchy.

All SDK errors inherit from DomiNodeError. HTTP status codes are mapped
to specific exception types for easy catch-and-handle patterns.
"""

from __future__ import annotations


class DomiNodeError(Exception):
    """Base exception for all DomiNode SDK errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AuthenticationError(DomiNodeError):
    """Raised on HTTP 401 -- invalid credentials or expired token."""

    def __init__(self, message: str = "Authentication failed") -> None:
        super().__init__(message, status_code=401)


class AuthorizationError(DomiNodeError):
    """Raised on HTTP 403 -- insufficient permissions."""

    def __init__(self, message: str = "Forbidden") -> None:
        super().__init__(message, status_code=403)


class RateLimitError(DomiNodeError):
    """Raised on HTTP 429 -- too many requests."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        retry_after_seconds: int = 60,
    ) -> None:
        super().__init__(message, status_code=429)
        self.retry_after_seconds = retry_after_seconds


class InsufficientBalanceError(DomiNodeError):
    """Raised on HTTP 402 -- wallet balance too low."""

    def __init__(self, message: str = "Insufficient balance") -> None:
        super().__init__(message, status_code=402)


class ValidationError(DomiNodeError):
    """Raised on HTTP 400 -- bad request / validation failure."""

    def __init__(self, message: str = "Validation error") -> None:
        super().__init__(message, status_code=400)


class NotFoundError(DomiNodeError):
    """Raised on HTTP 404 -- resource not found."""

    def __init__(self, message: str = "Not found") -> None:
        super().__init__(message, status_code=404)


class ConflictError(DomiNodeError):
    """Raised on HTTP 409 -- conflict (e.g. duplicate registration)."""

    def __init__(self, message: str = "Conflict") -> None:
        super().__init__(message, status_code=409)


class ServerError(DomiNodeError):
    """Raised on HTTP 500+ -- server-side error."""

    def __init__(self, message: str = "Internal server error", status_code: int = 500) -> None:
        super().__init__(message, status_code=status_code)


class NetworkError(DomiNodeError):
    """Raised on connection failures, timeouts, and DNS errors."""

    def __init__(self, message: str = "Network error") -> None:
        super().__init__(message, status_code=None)


class ProxyError(DomiNodeError):
    """Raised on proxy connection or configuration errors."""

    def __init__(self, message: str = "Proxy error") -> None:
        super().__init__(message, status_code=None)
