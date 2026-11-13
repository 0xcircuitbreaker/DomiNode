"""Error hierarchy.

Every message passes through :func:`scrub_credentials` so API keys
(dn_live_/dn_test_/dn_node_/dn_proxy_) and JWTs never reach logs or callers
via error strings.
"""

from __future__ import annotations

import re
from typing import Dict, Optional, Union

_CREDENTIAL_PATTERNS = [
    re.compile(r"dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+"),
    re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"),
]

Details = Dict[str, Union[int, float, str]]


def scrub_credentials(message: object) -> str:
    out = str(message)
    for pattern in _CREDENTIAL_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    return out


class DominusNodeError(Exception):
    """Base class. ``code`` is the server's error code (e.g. ``INVALID_CHALLENGE``)."""

    default_message = "DominusNode error"

    def __init__(
        self,
        message: Optional[str] = None,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
        details: Optional[Details] = None,
    ) -> None:
        self.message = scrub_credentials(message if message is not None else self.default_message)
        self.status_code = status_code
        self.code = code
        self.details = details
        super().__init__(self.message)

    def __str__(self) -> str:
        return self.message

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.message!r}, status_code={self.status_code!r}, code={self.code!r})"


class AuthenticationError(DominusNodeError):
    default_message = "Authentication failed"

    def __init__(self, message: Optional[str] = None, code: Optional[str] = None, details: Optional[Details] = None) -> None:
        super().__init__(message, 401, code, details)


class InsufficientBalanceError(DominusNodeError):
    default_message = "Insufficient balance"

    def __init__(self, message: Optional[str] = None, code: Optional[str] = None, details: Optional[Details] = None) -> None:
        super().__init__(message, 402, code, details)


class AuthorizationError(DominusNodeError):
    default_message = "Access denied"

    def __init__(self, message: Optional[str] = None, code: Optional[str] = None, details: Optional[Details] = None) -> None:
        super().__init__(message, 403, code, details)


class NotFoundError(DominusNodeError):
    default_message = "Resource not found"

    def __init__(self, message: Optional[str] = None, code: Optional[str] = None, details: Optional[Details] = None) -> None:
        super().__init__(message, 404, code, details)


class ConflictError(DominusNodeError):
    default_message = "Resource conflict"

    def __init__(self, message: Optional[str] = None, code: Optional[str] = None, details: Optional[Details] = None) -> None:
        super().__init__(message, 409, code, details)


class RateLimitError(DominusNodeError):
    default_message = "Rate limit exceeded"

    def __init__(
        self,
        message: Optional[str] = None,
        retry_after_seconds: int = 60,
        code: Optional[str] = None,
        details: Optional[Details] = None,
    ) -> None:
        super().__init__(message, 429, code, details)
        self.retry_after_seconds = retry_after_seconds


class ServerError(DominusNodeError):
    default_message = "Server error"

    def __init__(
        self,
        message: Optional[str] = None,
        status_code: int = 500,
        code: Optional[str] = None,
        details: Optional[Details] = None,
    ) -> None:
        super().__init__(message, status_code, code, details)


class ValidationError(DominusNodeError):
    """HTTP 400, or a client-side argument check (status_code None, code INVALID_ARGUMENT)."""

    default_message = "Validation failed"

    def __init__(
        self,
        message: Optional[str] = None,
        status_code: Optional[int] = 400,
        code: Optional[str] = None,
        details: Optional[Details] = None,
    ) -> None:
        super().__init__(message, status_code, code, details)


class NetworkError(DominusNodeError):
    default_message = "Network error"

    def __init__(self, message: Optional[str] = None) -> None:
        super().__init__(message)


class ProtocolError(DominusNodeError):
    """The server sent something the SDK refuses to act on, or a signer failed."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class ProxyError(DominusNodeError):
    """Failure inside proxy.fetch(): blocked target, refused tunnel, timeout."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message, status_code, code)
        #: Seconds from the gateway's Retry-After header on a refused CONNECT, if any.
        self.retry_after = retry_after


def invalid_arg(message: str) -> ValidationError:
    """Client-side argument validation failure (no request sent)."""
    return ValidationError(message, None, "INVALID_ARGUMENT")
