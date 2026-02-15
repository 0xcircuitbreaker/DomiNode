"""Tests for the Dominus Node error hierarchy."""

from __future__ import annotations

import pytest

from dominusnode import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    DominusNodeError,
    InsufficientBalanceError,
    NetworkError,
    NotFoundError,
    ProxyError,
    RateLimitError,
    ServerError,
    ValidationError,
)


class TestErrorHierarchy:
    """All SDK errors inherit from DominusNodeError."""

    def test_base_error(self) -> None:
        err = DominusNodeError("something broke", status_code=418)
        assert str(err) == "something broke"
        assert err.message == "something broke"
        assert err.status_code == 418

    def test_base_error_no_status(self) -> None:
        err = DominusNodeError("generic")
        assert err.status_code is None

    def test_authentication_error(self) -> None:
        err = AuthenticationError()
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 401
        assert "Authentication" in err.message

    def test_authentication_error_custom(self) -> None:
        err = AuthenticationError("bad creds")
        assert err.message == "bad creds"

    def test_authorization_error(self) -> None:
        err = AuthorizationError()
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 403

    def test_rate_limit_error(self) -> None:
        err = RateLimitError(retry_after_seconds=120)
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 429
        assert err.retry_after_seconds == 120

    def test_rate_limit_error_default_retry(self) -> None:
        err = RateLimitError()
        assert err.retry_after_seconds == 60

    def test_insufficient_balance_error(self) -> None:
        err = InsufficientBalanceError()
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 402

    def test_validation_error(self) -> None:
        err = ValidationError("bad input")
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 400
        assert err.message == "bad input"

    def test_not_found_error(self) -> None:
        err = NotFoundError()
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 404

    def test_conflict_error(self) -> None:
        err = ConflictError("duplicate")
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 409
        assert err.message == "duplicate"

    def test_server_error(self) -> None:
        err = ServerError()
        assert isinstance(err, DominusNodeError)
        assert err.status_code == 500

    def test_server_error_custom_status(self) -> None:
        err = ServerError("gateway timeout", status_code=504)
        assert err.status_code == 504
        assert err.message == "gateway timeout"

    def test_network_error(self) -> None:
        err = NetworkError("connection refused")
        assert isinstance(err, DominusNodeError)
        assert err.status_code is None
        assert err.message == "connection refused"

    def test_proxy_error(self) -> None:
        err = ProxyError("tunnel failed")
        assert isinstance(err, DominusNodeError)
        assert err.status_code is None
        assert err.message == "tunnel failed"


class TestErrorCatching:
    """Verify errors can be caught by parent type."""

    def test_catch_all_with_base(self) -> None:
        with pytest.raises(DominusNodeError):
            raise AuthenticationError("test")

    def test_catch_all_with_base_rate_limit(self) -> None:
        with pytest.raises(DominusNodeError):
            raise RateLimitError()

    def test_catch_specific(self) -> None:
        with pytest.raises(RateLimitError) as exc_info:
            raise RateLimitError("slow down", retry_after_seconds=30)
        assert exc_info.value.retry_after_seconds == 30

    def test_catch_network_as_base(self) -> None:
        with pytest.raises(DominusNodeError):
            raise NetworkError()

    def test_catch_proxy_as_base(self) -> None:
        with pytest.raises(DominusNodeError):
            raise ProxyError()
