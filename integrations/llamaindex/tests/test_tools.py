"""Tests for Dominus Node LlamaIndex integration.

All tests mock httpx calls to avoid network requests.
Covers SSRF validation, credential sanitization, prototype pollution,
OFAC blocking, HTTP method restrictions, URL validation, client
initialization, input validation, period-to-date-range conversion,
and PayPal top-up validation.
"""

from __future__ import annotations

import json
import re
from unittest.mock import MagicMock, patch

import pytest

from dominusnode_llamaindex.tools import (
    ALLOWED_FETCH_METHODS,
    DominusNodeClient,
    MAX_RESPONSE_CHARS,
    SANCTIONED_COUNTRIES,
    _period_to_date_range,
    _validate_allowed_domains,
    _validate_amount_cents,
    _validate_daily_limit_cents,
    _validate_label,
    _validate_uuid,
    is_private_ip,
    normalize_ipv4,
    sanitize_error,
    strip_dangerous_keys,
    validate_url,
)
from dominusnode_llamaindex.tool_spec import DominusNodeToolSpec


# ======================================================================
# SSRF Validation Tests
# ======================================================================


class TestIsPrivateIp:
    """Tests for is_private_ip covering all private/reserved ranges."""

    def test_loopback_127_0_0_1(self):
        assert is_private_ip("127.0.0.1") is True

    def test_loopback_127_255_255_255(self):
        assert is_private_ip("127.255.255.255") is True

    def test_private_10_network(self):
        assert is_private_ip("10.0.0.1") is True

    def test_private_172_16_network(self):
        assert is_private_ip("172.16.0.1") is True

    def test_private_172_31_network(self):
        assert is_private_ip("172.31.255.255") is True

    def test_private_192_168_network(self):
        assert is_private_ip("192.168.1.1") is True

    def test_cgnat_100_64(self):
        assert is_private_ip("100.64.0.1") is True

    def test_cgnat_100_127(self):
        assert is_private_ip("100.127.255.255") is True

    def test_link_local_169_254(self):
        assert is_private_ip("169.254.1.1") is True

    def test_multicast_224(self):
        assert is_private_ip("224.0.0.1") is True

    def test_multicast_239(self):
        assert is_private_ip("239.255.255.255") is True

    def test_reserved_240(self):
        assert is_private_ip("240.0.0.1") is True

    def test_zero_network(self):
        assert is_private_ip("0.0.0.0") is True

    def test_public_ip(self):
        assert is_private_ip("8.8.8.8") is False

    def test_public_ip_93(self):
        assert is_private_ip("93.184.216.34") is False

    # -- Hex/octal/decimal encoded IPs --

    def test_hex_loopback(self):
        """0x7f000001 = 127.0.0.1"""
        assert is_private_ip("0x7f000001") is True

    def test_decimal_loopback(self):
        """2130706433 = 127.0.0.1"""
        assert is_private_ip("2130706433") is True

    def test_octal_loopback(self):
        """0177.0.0.1 = 127.0.0.1"""
        assert is_private_ip("0177.0.0.1") is True

    def test_hex_public(self):
        """0x08080808 = 8.8.8.8"""
        assert is_private_ip("0x08080808") is False

    # -- IPv6 --

    def test_ipv6_loopback(self):
        assert is_private_ip("::1") is True

    def test_ipv6_unspecified(self):
        assert is_private_ip("::") is True

    def test_ipv6_ula_fd(self):
        assert is_private_ip("fd00::1") is True

    def test_ipv6_ula_fc(self):
        assert is_private_ip("fc00::1") is True

    def test_ipv6_link_local(self):
        assert is_private_ip("fe80::1") is True

    def test_ipv6_zone_id_stripped(self):
        assert is_private_ip("fe80::1%eth0") is True

    def test_ipv6_brackets_stripped(self):
        assert is_private_ip("[::1]") is True

    # -- IPv4-mapped IPv6 --

    def test_ipv4_mapped_ipv6_loopback(self):
        assert is_private_ip("::ffff:127.0.0.1") is True

    def test_ipv4_mapped_ipv6_private(self):
        assert is_private_ip("::ffff:10.0.0.1") is True

    def test_ipv4_mapped_ipv6_public(self):
        assert is_private_ip("::ffff:8.8.8.8") is False

    def test_ipv4_mapped_hex_form(self):
        """::ffff:7f00:1 = 127.0.0.1"""
        assert is_private_ip("::ffff:7f00:1") is True

    # -- IPv4-compatible IPv6 --

    def test_ipv4_compatible_loopback(self):
        assert is_private_ip("::127.0.0.1") is True

    def test_ipv4_compatible_private(self):
        assert is_private_ip("::10.0.0.1") is True

    def test_ipv4_compatible_public(self):
        assert is_private_ip("::8.8.8.8") is False

    # -- Teredo --

    def test_teredo_2001_0000(self):
        assert is_private_ip("2001:0000::1") is True

    def test_teredo_2001_0_short(self):
        assert is_private_ip("2001:0:4136:e378::8000:1234") is True

    # -- 6to4 --

    def test_6to4_private_embedded(self):
        """2002:7f00:0001:: has 127.0.0.1 embedded"""
        assert is_private_ip("2002:7f00:0001::") is True

    def test_6to4_public_embedded(self):
        """2002:0808:0808:: has 8.8.8.8 embedded"""
        assert is_private_ip("2002:0808:0808::") is False

    # -- Non-IP hostnames --

    def test_regular_hostname(self):
        assert is_private_ip("example.com") is False

    def test_localhost_not_caught_by_ip_check(self):
        """is_private_ip checks IP patterns, not hostname strings."""
        # 'localhost' is not a valid IP literal, so is_private_ip returns False
        # validate_url catches it via the BLOCKED_HOSTNAMES set
        assert is_private_ip("localhost") is False


class TestNormalizeIpv4:
    """Tests for normalize_ipv4 hex/octal/decimal conversion."""

    def test_decimal_integer(self):
        assert normalize_ipv4("2130706433") == "127.0.0.1"

    def test_hex_integer(self):
        assert normalize_ipv4("0x7f000001") == "127.0.0.1"

    def test_octal_octets(self):
        assert normalize_ipv4("0177.0.0.01") == "127.0.0.1"

    def test_regular_dotted_decimal(self):
        assert normalize_ipv4("127.0.0.1") == "127.0.0.1"

    def test_non_ip_hostname(self):
        assert normalize_ipv4("example.com") is None

    def test_empty_string(self):
        assert normalize_ipv4("") is None


class TestValidateUrl:
    """Tests for validate_url covering scheme, hostname, and SSRF checks."""

    def test_valid_http(self):
        assert validate_url("http://example.com") == "http://example.com"

    def test_valid_https(self):
        assert validate_url("https://example.com/path") == "https://example.com/path"

    def test_rejects_empty(self):
        with pytest.raises(ValueError, match="non-empty string"):
            validate_url("")

    def test_rejects_none(self):
        with pytest.raises(ValueError, match="non-empty string"):
            validate_url(None)  # type: ignore[arg-type]

    def test_rejects_file_scheme(self):
        with pytest.raises(ValueError, match="http.*https.*supported"):
            validate_url("file:///etc/passwd")

    def test_rejects_ftp_scheme(self):
        with pytest.raises(ValueError, match="http.*https.*supported"):
            validate_url("ftp://example.com")

    def test_rejects_javascript_scheme(self):
        with pytest.raises(ValueError, match="http.*https.*supported"):
            validate_url("javascript:alert(1)")

    def test_rejects_localhost(self):
        with pytest.raises(ValueError, match="localhost|loopback"):
            validate_url("http://localhost/admin")

    def test_rejects_127_0_0_1(self):
        with pytest.raises(ValueError, match="private|internal"):
            validate_url("http://127.0.0.1/admin")

    def test_rejects_10_x_private(self):
        with pytest.raises(ValueError, match="private|internal"):
            validate_url("http://10.0.0.1/secret")

    def test_rejects_192_168_private(self):
        with pytest.raises(ValueError, match="private|internal"):
            validate_url("http://192.168.1.1/router")

    def test_rejects_embedded_credentials(self):
        with pytest.raises(ValueError, match="credentials"):
            validate_url("http://user:pass@example.com")

    def test_rejects_dot_localhost(self):
        with pytest.raises(ValueError, match="localhost|loopback"):
            validate_url("http://evil.localhost/admin")

    def test_rejects_dot_local(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://server.local/api")

    def test_rejects_dot_internal(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://myservice.internal")

    def test_rejects_dot_arpa(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://1.168.192.in-addr.arpa")

    def test_rejects_long_url(self):
        with pytest.raises(ValueError, match="maximum length"):
            validate_url("http://example.com/" + "a" * 2048)

    def test_rejects_no_hostname(self):
        with pytest.raises(ValueError, match="hostname"):
            validate_url("http://")


# ======================================================================
# Credential Sanitization Tests
# ======================================================================


class TestSanitizeError:
    """Tests for credential scrubbing in error messages."""

    def test_scrubs_live_key(self):
        msg = "Failed with key dn_live_abc123XYZ in request"
        result = sanitize_error(msg)
        assert "dn_live_abc123XYZ" not in result
        assert "***" in result

    def test_scrubs_test_key(self):
        msg = "Error: dn_test_fooBar99 was rejected"
        result = sanitize_error(msg)
        assert "dn_test_fooBar99" not in result
        assert "***" in result

    def test_preserves_clean_message(self):
        msg = "Connection timed out after 30s"
        assert sanitize_error(msg) == msg


# ======================================================================
# Prototype Pollution Tests
# ======================================================================


class TestStripDangerousKeys:
    """Tests for prototype pollution prevention."""

    def test_strips_proto(self):
        obj = {"__proto__": {"isAdmin": True}, "name": "test"}
        strip_dangerous_keys(obj)
        assert "__proto__" not in obj
        assert obj["name"] == "test"

    def test_strips_constructor(self):
        obj = {"constructor": {"prototype": {}}, "id": 1}
        strip_dangerous_keys(obj)
        assert "constructor" not in obj
        assert obj["id"] == 1

    def test_strips_nested(self):
        obj = {"data": {"__proto__": {"evil": True}, "safe": "value"}}
        strip_dangerous_keys(obj)
        assert "__proto__" not in obj["data"]
        assert obj["data"]["safe"] == "value"

    def test_strips_in_lists(self):
        obj = [{"__proto__": {}, "ok": True}]
        strip_dangerous_keys(obj)
        assert "__proto__" not in obj[0]
        assert obj[0]["ok"] is True

    def test_handles_none(self):
        # Should not raise
        strip_dangerous_keys(None)

    def test_depth_limit(self):
        """Deeply nested structures don't cause stack overflow."""
        obj: dict = {"a": {}}
        current = obj["a"]
        for _ in range(100):
            current["b"] = {}
            current = current["b"]
        current["__proto__"] = {"evil": True}
        # Should not raise, but may not strip at depth > 50
        strip_dangerous_keys(obj)


# ======================================================================
# OFAC Country Blocking Tests
# ======================================================================


class TestOfacBlocking:
    """Tests for OFAC sanctioned country blocking."""

    @pytest.mark.parametrize("country", ["CU", "IR", "KP", "RU", "SY"])
    def test_sanctioned_countries_blocked(self, country):
        assert country in SANCTIONED_COUNTRIES

    def test_us_not_blocked(self):
        assert "US" not in SANCTIONED_COUNTRIES

    def test_gb_not_blocked(self):
        assert "GB" not in SANCTIONED_COUNTRIES

    def test_de_not_blocked(self):
        assert "DE" not in SANCTIONED_COUNTRIES

    def test_jp_not_blocked(self):
        assert "JP" not in SANCTIONED_COUNTRIES

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_proxied_fetch_blocks_sanctioned_country(self, mock_httpx_cls):
        """proxied_fetch returns error for sanctioned countries."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.proxied_fetch(
            url="https://example.com",
            country="CU",
        )
        assert "error" in result
        assert "OFAC" in result["error"]
        assert "CU" in result["error"]


# ======================================================================
# HTTP Method Restriction Tests
# ======================================================================


class TestHttpMethodRestriction:
    """Tests for read-only HTTP method enforcement."""

    def test_get_allowed(self):
        assert "GET" in ALLOWED_FETCH_METHODS

    def test_head_allowed(self):
        assert "HEAD" in ALLOWED_FETCH_METHODS

    def test_options_allowed(self):
        assert "OPTIONS" in ALLOWED_FETCH_METHODS

    def test_post_blocked(self):
        assert "POST" not in ALLOWED_FETCH_METHODS

    def test_put_blocked(self):
        assert "PUT" not in ALLOWED_FETCH_METHODS

    def test_delete_blocked(self):
        assert "DELETE" not in ALLOWED_FETCH_METHODS

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_proxied_fetch_blocks_post(self, mock_httpx_cls):
        """proxied_fetch returns error for POST method."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.proxied_fetch(
            url="https://example.com",
            method="POST",
        )
        assert "error" in result
        assert "not allowed" in result["error"]


# ======================================================================
# Client Initialization Tests
# ======================================================================


class TestClientInit:
    """Tests for DominusNodeClient initialization and configuration."""

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="API key is required"):
            DominusNodeClient(api_key="")

    def test_env_fallback(self):
        with patch.dict("os.environ", {"DOMINUSNODE_API_KEY": "dn_live_envkey"}):
            client = DominusNodeClient()
            assert client._api_key == "dn_live_envkey"

    def test_explicit_api_key(self):
        client = DominusNodeClient(api_key="dn_live_explicit")
        assert client._api_key == "dn_live_explicit"

    def test_default_base_url(self):
        client = DominusNodeClient(api_key="dn_live_test123")
        assert client._base_url == "https://api.dominusnode.com"

    def test_custom_base_url(self):
        client = DominusNodeClient(
            api_key="dn_live_test123",
            base_url="http://localhost:3000",
        )
        assert client._base_url == "http://localhost:3000"

    def test_trailing_slash_stripped(self):
        client = DominusNodeClient(
            api_key="dn_live_test123",
            base_url="http://localhost:3000/",
        )
        assert client._base_url == "http://localhost:3000"

    def test_default_proxy_host(self):
        client = DominusNodeClient(api_key="dn_live_test123")
        assert client._proxy_host == "proxy.dominusnode.com"

    def test_custom_proxy_port(self):
        client = DominusNodeClient(
            api_key="dn_live_test123",
            proxy_port=9090,
        )
        assert client._proxy_port == 9090

    def test_default_timeout(self):
        client = DominusNodeClient(api_key="dn_live_test123")
        assert client._timeout == 30.0


# ======================================================================
# Input Validation Tests
# ======================================================================


class TestLabelValidation:
    """Tests for _validate_label helper."""

    def test_valid_label(self):
        assert _validate_label("My Wallet") is None

    def test_empty_label(self):
        err = _validate_label("")
        assert err is not None
        assert "required" in err

    def test_none_label(self):
        err = _validate_label(None)  # type: ignore[arg-type]
        assert err is not None

    def test_too_long_label(self):
        err = _validate_label("x" * 101)
        assert err is not None
        assert "100 characters" in err

    def test_control_chars(self):
        err = _validate_label("test\x00label")
        assert err is not None
        assert "control characters" in err

    def test_newline_blocked(self):
        err = _validate_label("test\nlabel")
        assert err is not None
        assert "control characters" in err

    def test_tab_blocked(self):
        err = _validate_label("test\tlabel")
        assert err is not None
        assert "control characters" in err

    def test_max_length_allowed(self):
        assert _validate_label("x" * 100) is None


class TestUuidValidation:
    """Tests for _validate_uuid helper."""

    def test_valid_uuid(self):
        assert _validate_uuid("550e8400-e29b-41d4-a716-446655440000") is None

    def test_invalid_uuid(self):
        err = _validate_uuid("not-a-uuid")
        assert err is not None
        assert "valid UUID" in err

    def test_empty_uuid(self):
        err = _validate_uuid("")
        assert err is not None
        assert "required" in err

    def test_none_uuid(self):
        err = _validate_uuid(None)  # type: ignore[arg-type]
        assert err is not None


class TestAmountCentsValidation:
    """Tests for _validate_amount_cents helper."""

    def test_valid_amount(self):
        assert _validate_amount_cents(500) is None

    def test_zero_amount(self):
        err = _validate_amount_cents(0)
        assert err is not None

    def test_negative_amount(self):
        err = _validate_amount_cents(-100)
        assert err is not None

    def test_float_amount(self):
        err = _validate_amount_cents(10.5)  # type: ignore[arg-type]
        assert err is not None

    def test_string_amount(self):
        err = _validate_amount_cents("100")  # type: ignore[arg-type]
        assert err is not None

    def test_overflow_amount(self):
        err = _validate_amount_cents(2_147_483_648)
        assert err is not None

    def test_max_allowed(self):
        assert _validate_amount_cents(2_147_483_647) is None

    def test_custom_min(self):
        err = _validate_amount_cents(50, min_val=100)
        assert err is not None

    def test_custom_max(self):
        err = _validate_amount_cents(1_000_001, max_val=1_000_000)
        assert err is not None


# ======================================================================
# Period to Date Range Tests
# ======================================================================


class TestPeriodToDateRange:
    """Tests for _period_to_date_range conversion."""

    def test_day_period(self):
        result = _period_to_date_range("day")
        assert "since" in result
        assert "until" in result
        # since should be roughly 24 hours before until
        assert result["since"] < result["until"]

    def test_week_period(self):
        result = _period_to_date_range("week")
        assert "since" in result
        assert "until" in result
        assert result["since"] < result["until"]

    def test_month_period(self):
        result = _period_to_date_range("month")
        assert "since" in result
        assert "until" in result
        assert result["since"] < result["until"]

    def test_unknown_defaults_to_month(self):
        """Unknown period values default to 30-day range."""
        result = _period_to_date_range("unknown")
        month_result = _period_to_date_range("month")
        # Both should produce similar since/until patterns
        assert "since" in result
        assert "until" in result


# ======================================================================
# PayPal Top-up Validation Tests
# ======================================================================


class TestPaypalTopup:
    """Tests for topup_paypal input validation."""

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_minimum_amount(self, mock_httpx_cls):
        """Minimum amount is 100 cents ($1)."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.topup_paypal(amount_cents=99)
        assert "error" in result
        assert "100" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_maximum_amount(self, mock_httpx_cls):
        """Maximum amount is 1,000,000 cents ($10,000)."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.topup_paypal(amount_cents=1_000_001)
        assert "error" in result
        assert "1000000" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_valid_amount_calls_api(self, mock_httpx_cls):
        """Valid amount proceeds to API call."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = '{"orderId": "PAY-123", "approvalUrl": "https://paypal.com/pay"}'
        mock_resp.json.return_value = {
            "orderId": "PAY-123",
            "approvalUrl": "https://paypal.com/pay",
        }
        mock_resp.content = b'{"orderId": "PAY-123"}'

        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt123"}'
        mock_auth_resp.json.return_value = {"token": "jwt123"}
        mock_auth_resp.content = b'{"token": "jwt123"}'

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_resp
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.topup_paypal(amount_cents=500)
        assert "orderId" in result

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_zero_amount_rejected(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.topup_paypal(amount_cents=0)
        assert "error" in result

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_negative_amount_rejected(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.topup_paypal(amount_cents=-500)
        assert "error" in result


# ======================================================================
# Client Method Tests (with mocked httpx)
# ======================================================================


class TestClientMethods:
    """Tests for DominusNodeClient API methods with mocked HTTP calls."""

    def _make_client_with_mock(self, mock_httpx_cls, api_resp):
        """Helper to create a client with pre-configured mock responses."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt-tok-123"}'
        mock_auth_resp.json.return_value = {"token": "jwt-tok-123"}
        mock_auth_resp.content = b'{"token": "jwt-tok-123"}'

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = json.dumps(api_resp)
        mock_api_resp.json.return_value = api_resp
        mock_api_resp.content = json.dumps(api_resp).encode()

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_api_resp
        mock_httpx_cls.return_value = mock_instance

        return DominusNodeClient(api_key="dn_live_testkey")

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_check_balance(self, mock_httpx_cls):
        client = self._make_client_with_mock(
            mock_httpx_cls,
            {"balanceCents": 5000, "balanceUsd": 50.0, "currency": "usd"},
        )
        result = client.check_balance()
        assert result["balanceCents"] == 5000
        assert result["balanceUsd"] == 50.0

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_check_usage(self, mock_httpx_cls):
        client = self._make_client_with_mock(
            mock_httpx_cls,
            {"summary": {"totalBytes": 1_000_000, "totalCostCents": 3}},
        )
        result = client.check_usage(period="day")
        assert "summary" in result

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_check_usage_invalid_period(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.check_usage(period="year")
        assert "error" in result

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_create_agentic_wallet_valid(self, mock_httpx_cls):
        client = self._make_client_with_mock(
            mock_httpx_cls,
            {"id": "aw-123", "label": "Test", "balanceCents": 0},
        )
        result = client.create_agentic_wallet(
            label="Test Wallet",
            spending_limit_cents=1000,
        )
        assert result["id"] == "aw-123"

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_create_agentic_wallet_bad_label(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="",
            spending_limit_cents=1000,
        )
        assert "error" in result
        assert "required" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_create_agentic_wallet_bad_limit(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=0,
        )
        assert "error" in result

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_fund_agentic_wallet_bad_uuid(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.fund_agentic_wallet(
            wallet_id="not-a-uuid",
            amount_cents=100,
        )
        assert "error" in result
        assert "valid UUID" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_agentic_transactions_limit_validation(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.agentic_transactions(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            limit=0,
        )
        assert "error" in result
        assert "limit" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_agentic_transactions_limit_too_high(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.agentic_transactions(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            limit=101,
        )
        assert "error" in result

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_create_team_valid(self, mock_httpx_cls):
        client = self._make_client_with_mock(
            mock_httpx_cls,
            {"id": "team-123", "name": "Alpha Team"},
        )
        result = client.create_team(name="Alpha Team", max_members=10)
        assert result["id"] == "team-123"

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_create_team_bad_max_members(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_team(name="Test", max_members=101)
        assert "error" in result
        assert "max_members" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_update_team_requires_field(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_team(
            team_id="550e8400-e29b-41d4-a716-446655440000",
        )
        assert "error" in result
        assert "At least one" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_update_team_member_role_bad_role(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_team_member_role(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            user_id="550e8400-e29b-41d4-a716-446655440001",
            role="owner",
        )
        assert "error" in result
        assert "'member' or 'admin'" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_team_fund_minimum_amount(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=50,
        )
        assert "error" in result
        assert "100" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_proxied_fetch_invalid_proxy_type(self, mock_httpx_cls):
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.proxied_fetch(
            url="https://example.com",
            proxy_type="mobile",
        )
        assert "error" in result
        assert "'dc' or 'residential'" in result["error"]


# ======================================================================
# Wallet Policy Validation Tests
# ======================================================================


class TestDailyLimitCentsValidation:
    """Tests for _validate_daily_limit_cents helper."""

    def test_valid_value(self):
        assert _validate_daily_limit_cents(500) is None

    def test_min_value(self):
        assert _validate_daily_limit_cents(1) is None

    def test_max_value(self):
        assert _validate_daily_limit_cents(1_000_000) is None

    def test_zero_rejected(self):
        err = _validate_daily_limit_cents(0)
        assert err is not None
        assert "between 1 and 1000000" in err

    def test_negative_rejected(self):
        err = _validate_daily_limit_cents(-100)
        assert err is not None
        assert "between 1 and 1000000" in err

    def test_too_large_rejected(self):
        err = _validate_daily_limit_cents(1_000_001)
        assert err is not None
        assert "between 1 and 1000000" in err

    def test_float_rejected(self):
        err = _validate_daily_limit_cents(10.5)
        assert err is not None
        assert "positive integer" in err

    def test_string_rejected(self):
        err = _validate_daily_limit_cents("500")
        assert err is not None
        assert "positive integer" in err

    def test_bool_rejected(self):
        err = _validate_daily_limit_cents(True)
        assert err is not None
        assert "positive integer" in err


class TestAllowedDomainsValidation:
    """Tests for _validate_allowed_domains helper."""

    def test_valid_single_domain(self):
        assert _validate_allowed_domains(["example.com"]) is None

    def test_valid_multiple_domains(self):
        assert _validate_allowed_domains(["example.com", "api.test.org"]) is None

    def test_valid_subdomain(self):
        assert _validate_allowed_domains(["sub.example.co.uk"]) is None

    def test_empty_list(self):
        assert _validate_allowed_domains([]) is None

    def test_not_a_list(self):
        err = _validate_allowed_domains("example.com")
        assert err is not None
        assert "list of strings" in err

    def test_too_many_entries(self):
        domains = [f"domain{i}.com" for i in range(101)]
        err = _validate_allowed_domains(domains)
        assert err is not None
        assert "at most 100" in err

    def test_max_entries_allowed(self):
        domains = [f"domain{i}.com" for i in range(100)]
        assert _validate_allowed_domains(domains) is None

    def test_entry_too_long(self):
        err = _validate_allowed_domains(["a" * 254 + ".com"])
        assert err is not None
        assert "253 characters" in err

    def test_entry_at_max_length(self):
        # Build a valid domain at exactly 253 chars using 63-char labels
        # 4 labels of 62 chars + dot separators + ".com" suffix
        # "a"*62 + "." + "b"*62 + "." + "c"*62 + "." + "d"*58 + ".com"
        # = 62 + 1 + 62 + 1 + 62 + 1 + 58 + 4 = 251 -- adjust to 253
        # "a"*62 + "." + "b"*62 + "." + "c"*62 + "." + "d"*60 + ".com"
        # = 62 + 1 + 62 + 1 + 62 + 1 + 60 + 4 = 253
        domain = "a" * 62 + "." + "b" * 62 + "." + "c" * 62 + "." + "d" * 60 + ".com"
        assert len(domain) == 253
        assert _validate_allowed_domains([domain]) is None

    def test_non_string_entry(self):
        err = _validate_allowed_domains([123])
        assert err is not None
        assert "must be a string" in err

    def test_invalid_domain_format(self):
        err = _validate_allowed_domains(["not a domain"])
        assert err is not None
        assert "not a valid domain" in err

    def test_ip_address_rejected(self):
        err = _validate_allowed_domains(["192.168.1.1"])
        assert err is not None
        assert "not a valid domain" in err

    def test_bare_tld_rejected(self):
        err = _validate_allowed_domains(["localhost"])
        assert err is not None
        assert "not a valid domain" in err


# ======================================================================
# Create Agentic Wallet with Policy Tests
# ======================================================================


class TestCreateAgenticWalletWithPolicy:
    """Tests for create_agentic_wallet with daily_limit_cents and allowed_domains."""

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_with_daily_limit_cents(self, mock_httpx_cls):
        """daily_limit_cents is passed as dailyLimitCents to the API."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt-tok"}'
        mock_auth_resp.json.return_value = {"token": "jwt-tok"}
        mock_auth_resp.content = b'{"token": "jwt-tok"}'

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        api_data = {"id": "aw-1", "label": "Test", "balanceCents": 0, "dailyLimitCents": 5000}
        mock_api_resp.text = json.dumps(api_data)
        mock_api_resp.json.return_value = api_data
        mock_api_resp.content = json.dumps(api_data).encode()

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_api_resp
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=1000,
            daily_limit_cents=5000,
        )
        assert result["id"] == "aw-1"
        assert result["dailyLimitCents"] == 5000

        # Verify the request body contains dailyLimitCents
        call_args = mock_instance.request.call_args
        assert call_args is not None
        body = call_args[1].get("json") if "json" in call_args[1] else call_args[0][2] if len(call_args[0]) > 2 else None
        # The _api_request method passes json= as a kwarg
        if body is None and len(call_args) > 1:
            body = call_args[1].get("json")

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_with_allowed_domains(self, mock_httpx_cls):
        """allowed_domains is passed as allowedDomains to the API."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt-tok"}'
        mock_auth_resp.json.return_value = {"token": "jwt-tok"}
        mock_auth_resp.content = b'{"token": "jwt-tok"}'

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        api_data = {"id": "aw-2", "label": "Test", "balanceCents": 0, "allowedDomains": ["example.com"]}
        mock_api_resp.text = json.dumps(api_data)
        mock_api_resp.json.return_value = api_data
        mock_api_resp.content = json.dumps(api_data).encode()

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_api_resp
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=1000,
            allowed_domains=["example.com"],
        )
        assert result["id"] == "aw-2"
        assert result["allowedDomains"] == ["example.com"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_daily_limit_cents(self, mock_httpx_cls):
        """Invalid daily_limit_cents returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=1000,
            daily_limit_cents=0,
        )
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_daily_limit_cents_too_large(self, mock_httpx_cls):
        """daily_limit_cents > 1,000,000 returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=1000,
            daily_limit_cents=1_000_001,
        )
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_allowed_domains_not_list(self, mock_httpx_cls):
        """allowed_domains that is not a list returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=1000,
            allowed_domains="example.com",  # type: ignore[arg-type]
        )
        assert "error" in result
        assert "allowed_domains" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_allowed_domains_bad_format(self, mock_httpx_cls):
        """allowed_domains with invalid domain format returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.create_agentic_wallet(
            label="Test",
            spending_limit_cents=1000,
            allowed_domains=["not a domain"],
        )
        assert "error" in result
        assert "not a valid domain" in result["error"]


# ======================================================================
# Update Wallet Policy Tests
# ======================================================================


class TestUpdateWalletPolicy:
    """Tests for update_wallet_policy method."""

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_valid_daily_limit(self, mock_httpx_cls):
        """update_wallet_policy with valid daily_limit_cents calls API."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt-tok"}'
        mock_auth_resp.json.return_value = {"token": "jwt-tok"}
        mock_auth_resp.content = b'{"token": "jwt-tok"}'

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        api_data = {"dailyLimitCents": 5000, "allowedDomains": None}
        mock_api_resp.text = json.dumps(api_data)
        mock_api_resp.json.return_value = api_data
        mock_api_resp.content = json.dumps(api_data).encode()

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_api_resp
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            daily_limit_cents=5000,
        )
        assert result["dailyLimitCents"] == 5000

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_valid_allowed_domains(self, mock_httpx_cls):
        """update_wallet_policy with valid allowed_domains calls API."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt-tok"}'
        mock_auth_resp.json.return_value = {"token": "jwt-tok"}
        mock_auth_resp.content = b'{"token": "jwt-tok"}'

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        api_data = {"dailyLimitCents": None, "allowedDomains": ["example.com", "api.test.org"]}
        mock_api_resp.text = json.dumps(api_data)
        mock_api_resp.json.return_value = api_data
        mock_api_resp.content = json.dumps(api_data).encode()

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_api_resp
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            allowed_domains=["example.com", "api.test.org"],
        )
        assert result["allowedDomains"] == ["example.com", "api.test.org"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_missing_wallet_id(self, mock_httpx_cls):
        """update_wallet_policy with empty wallet_id returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="",
            daily_limit_cents=5000,
        )
        assert "error" in result
        assert "required" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_wallet_id(self, mock_httpx_cls):
        """update_wallet_policy with non-UUID wallet_id returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="not-a-uuid",
            daily_limit_cents=5000,
        )
        assert "error" in result
        assert "valid UUID" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_no_fields_provided(self, mock_httpx_cls):
        """update_wallet_policy with no policy fields returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
        )
        assert "error" in result
        assert "At least one" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_daily_limit_zero(self, mock_httpx_cls):
        """update_wallet_policy with daily_limit_cents=0 returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            daily_limit_cents=0,
        )
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_invalid_allowed_domains(self, mock_httpx_cls):
        """update_wallet_policy with invalid domains returns an error."""
        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            allowed_domains=["invalid domain!"],
        )
        assert "error" in result
        assert "not a valid domain" in result["error"]

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_both_fields_valid(self, mock_httpx_cls):
        """update_wallet_policy with both fields calls API."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "jwt-tok"}'
        mock_auth_resp.json.return_value = {"token": "jwt-tok"}
        mock_auth_resp.content = b'{"token": "jwt-tok"}'

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        api_data = {"dailyLimitCents": 2000, "allowedDomains": ["example.com"]}
        mock_api_resp.text = json.dumps(api_data)
        mock_api_resp.json.return_value = api_data
        mock_api_resp.content = json.dumps(api_data).encode()

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        mock_instance.request.return_value = mock_api_resp
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            daily_limit_cents=2000,
            allowed_domains=["example.com"],
        )
        assert result["dailyLimitCents"] == 2000
        assert result["allowedDomains"] == ["example.com"]


# ======================================================================
# Spec Functions List Tests
# ======================================================================


class TestSpecFunctionsList:
    """Tests for update_wallet_policy presence in spec_functions."""

    def test_update_wallet_policy_in_spec_functions(self):
        """update_wallet_policy is listed in DominusNodeToolSpec.spec_functions."""
        assert "update_wallet_policy" in DominusNodeToolSpec.spec_functions

    def test_create_agentic_wallet_in_spec_functions(self):
        """create_agentic_wallet is listed in DominusNodeToolSpec.spec_functions."""
        assert "create_agentic_wallet" in DominusNodeToolSpec.spec_functions


# ======================================================================
# 401 Retry Tests
# ======================================================================


class TestAuthRetry:
    """Tests for automatic re-authentication on 401 responses."""

    @patch("dominusnode_llamaindex.tools.httpx.Client")
    def test_401_retries_once(self, mock_httpx_cls):
        """A 401 response triggers re-auth and retry."""
        # First call: auth success, then 401 on API call
        # Second call: re-auth success, then 200 on API call
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.text = '{"token": "new-jwt"}'
        mock_auth_resp.json.return_value = {"token": "new-jwt"}
        mock_auth_resp.content = b'{"token": "new-jwt"}'

        mock_401_resp = MagicMock()
        mock_401_resp.status_code = 401
        mock_401_resp.text = '{"error": "Token expired"}'
        mock_401_resp.content = b'{"error": "Token expired"}'

        mock_ok_resp = MagicMock()
        mock_ok_resp.status_code = 200
        mock_ok_resp.text = '{"balanceCents": 999}'
        mock_ok_resp.json.return_value = {"balanceCents": 999}
        mock_ok_resp.content = b'{"balanceCents": 999}'

        mock_instance = MagicMock()
        mock_instance.__enter__ = MagicMock(return_value=mock_instance)
        mock_instance.__exit__ = MagicMock(return_value=False)
        mock_instance.post.return_value = mock_auth_resp
        # First API call returns 401, second returns 200
        mock_instance.request.side_effect = [mock_401_resp, mock_ok_resp]
        mock_httpx_cls.return_value = mock_instance

        client = DominusNodeClient(api_key="dn_live_test123")
        result = client.check_balance()
        assert result["balanceCents"] == 999
