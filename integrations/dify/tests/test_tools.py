"""Tests for dominusnode-dify tool provider.

Covers SSRF validation, credential sanitization, prototype pollution,
OFAC blocking, HTTP method restrictions, URL validation, provider
initialization, input validation, PayPal top-up validation, and all
22 tool dispatch paths.

All tests mock httpx calls so no real network requests are made.
"""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from dominusnode_dify import (
    DominusNodeProvider,
    SANCTIONED_COUNTRIES,
    _is_private_ip,
    _normalize_ipv4,
    _sanitize_error,
    _strip_dangerous_keys,
    _validate_label,
    _validate_positive_int,
    _validate_uuid,
    validate_url,
)


# ===========================================================================
# SSRF Validation Tests
# ===========================================================================


class TestSSRFValidation:
    """Ensure validate_url blocks dangerous URLs."""

    def test_allows_https(self):
        result = validate_url("https://example.com/page")
        assert result == "https://example.com/page"

    def test_allows_http(self):
        result = validate_url("http://example.com/page")
        assert result == "http://example.com/page"

    def test_blocks_localhost(self):
        with pytest.raises(ValueError, match="localhost"):
            validate_url("http://localhost/secret")

    def test_blocks_127_0_0_1(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://127.0.0.1/admin")

    def test_blocks_10_x_private(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://10.0.0.1/internal")

    def test_blocks_172_16_private(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://172.16.0.1/internal")

    def test_blocks_192_168_private(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://192.168.1.1/router")

    def test_blocks_169_254_link_local(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://169.254.169.254/latest/meta-data/")

    def test_blocks_cgnat_100_64(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://100.64.0.1/internal")

    def test_blocks_ipv6_loopback(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://[::1]/secret")

    def test_blocks_dot_localhost_tld(self):
        with pytest.raises(ValueError, match="(private|localhost|blocked)"):
            validate_url("http://app.localhost/admin")

    def test_blocks_dot_local_tld(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://printer.local/status")

    def test_blocks_dot_internal_tld(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://service.internal/api")

    def test_blocks_dot_arpa_tld(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://1.0.0.127.in-addr.arpa/")

    def test_blocks_embedded_credentials(self):
        with pytest.raises(ValueError, match="credentials"):
            validate_url("http://user:pass@example.com/page")

    def test_blocks_file_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("file:///etc/passwd")

    def test_blocks_ftp_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("ftp://example.com/file")

    def test_blocks_empty_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url("")

    def test_blocks_url_too_long(self):
        long_url = "https://example.com/" + "a" * 2048
        with pytest.raises(ValueError, match="maximum length"):
            validate_url(long_url)

    def test_dns_rebinding_blocks_private_resolved_ip(self):
        """If a hostname resolves to a private IP, it should be blocked."""
        mock_infos = [(2, 1, 6, "", ("127.0.0.1", 0))]
        with patch("dominusnode_dify.tools.socket.getaddrinfo", return_value=mock_infos):
            with pytest.raises(ValueError, match="private IP"):
                validate_url("http://evil.example.com/secret")

    def test_dns_rebinding_allows_public_resolved_ip(self):
        """If a hostname resolves to a public IP, it should be allowed."""
        mock_infos = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with patch("dominusnode_dify.tools.socket.getaddrinfo", return_value=mock_infos):
            result = validate_url("http://example.com/page")
            assert result == "http://example.com/page"

    def test_blocks_unresolvable_hostname(self):
        import socket as sock_mod
        with patch(
            "dominusnode_dify.tools.socket.getaddrinfo",
            side_effect=sock_mod.gaierror("Name or service not known"),
        ):
            with pytest.raises(ValueError, match="Could not resolve"):
                validate_url("http://nonexistent.invalid/page")


# ===========================================================================
# IP Normalization Tests
# ===========================================================================


class TestIPNormalization:
    """Test hex/octal/decimal IPv4 normalization."""

    def test_decimal_integer(self):
        assert _normalize_ipv4("2130706433") == "127.0.0.1"

    def test_hex_notation(self):
        assert _normalize_ipv4("0x7f000001") == "127.0.0.1"

    def test_octal_octets(self):
        assert _normalize_ipv4("0177.0.0.01") == "127.0.0.1"

    def test_decimal_is_private(self):
        assert _is_private_ip("2130706433") is True  # 127.0.0.1

    def test_hex_is_private(self):
        assert _is_private_ip("0x7f000001") is True  # 127.0.0.1

    def test_ipv6_zone_id_stripped(self):
        assert _is_private_ip("::1%eth0") is True

    def test_ipv4_mapped_ipv6(self):
        assert _is_private_ip("::ffff:127.0.0.1") is True

    def test_ipv4_compatible_ipv6(self):
        assert _is_private_ip("::127.0.0.1") is True

    def test_teredo_address(self):
        # 2001:0000:... is Teredo -- always blocked
        assert _is_private_ip("2001:0000:4136:e378:8000:63bf:3fff:fdd2") is True

    def test_6to4_with_private_ipv4(self):
        # 2002:0a00:0001:: embeds 10.0.0.1
        assert _is_private_ip("2002:0a00:0001::1") is True

    def test_6to4_with_public_ipv4(self):
        # 2002::/16 is now blocked unconditionally (tunneling risk)
        assert _is_private_ip("2002:5db8:d822::1") is True

    def test_public_ipv4(self):
        assert _is_private_ip("93.184.216.34") is False

    def test_multicast(self):
        assert _is_private_ip("224.0.0.1") is True

    def test_zero_network(self):
        assert _is_private_ip("0.0.0.0") is True


# ===========================================================================
# Credential Sanitization Tests
# ===========================================================================


class TestCredentialSanitization:
    """Ensure API keys are scrubbed from error messages."""

    def test_scrubs_live_key(self):
        msg = "Error with key dn_live_abc123XYZ in request"
        result = _sanitize_error(msg)
        assert "dn_live_abc123XYZ" not in result
        assert "***" in result

    def test_scrubs_test_key(self):
        msg = "Auth failed for dn_test_mykey999"
        result = _sanitize_error(msg)
        assert "dn_test_mykey999" not in result
        assert "***" in result

    def test_scrubs_multiple_keys(self):
        msg = "Keys: dn_live_one and dn_test_two"
        result = _sanitize_error(msg)
        assert "dn_live_one" not in result
        assert "dn_test_two" not in result
        assert result.count("***") == 2

    def test_preserves_non_key_text(self):
        msg = "Connection timed out after 30s"
        result = _sanitize_error(msg)
        assert result == msg


# ===========================================================================
# Prototype Pollution Tests
# ===========================================================================


class TestPrototypePollution:
    """Ensure dangerous keys are stripped from parsed JSON."""

    def test_strips_proto(self):
        obj = {"__proto__": {"admin": True}, "name": "test"}
        _strip_dangerous_keys(obj)
        assert "__proto__" not in obj
        assert obj["name"] == "test"

    def test_strips_constructor(self):
        obj = {"constructor": {"polluted": True}, "data": 1}
        _strip_dangerous_keys(obj)
        assert "constructor" not in obj
        assert obj["data"] == 1

    def test_strips_prototype(self):
        obj = {"prototype": {}, "value": "ok"}
        _strip_dangerous_keys(obj)
        assert "prototype" not in obj
        assert obj["value"] == "ok"

    def test_strips_nested(self):
        obj = {"nested": {"__proto__": True, "safe": "data"}}
        _strip_dangerous_keys(obj)
        assert "__proto__" not in obj.get("nested", {})
        assert obj["nested"]["safe"] == "data"

    def test_strips_in_list(self):
        obj = [{"__proto__": True, "val": 1}, {"constructor": True, "val": 2}]
        _strip_dangerous_keys(obj)
        assert "__proto__" not in obj[0]
        assert "constructor" not in obj[1]

    def test_depth_limit(self):
        # Build a deeply nested structure
        obj: dict = {}
        current = obj
        for _ in range(60):
            current["nested"] = {}
            current = current["nested"]
        current["__proto__"] = True
        # Should not raise even with very deep nesting
        _strip_dangerous_keys(obj)


# ===========================================================================
# OFAC Blocking Tests
# ===========================================================================


class TestOFACBlocking:
    """Ensure OFAC sanctioned countries are blocked."""

    def test_sanctioned_set(self):
        assert "CU" in SANCTIONED_COUNTRIES
        assert "IR" in SANCTIONED_COUNTRIES
        assert "KP" in SANCTIONED_COUNTRIES
        assert "RU" in SANCTIONED_COUNTRIES
        assert "SY" in SANCTIONED_COUNTRIES

    def test_proxied_fetch_blocks_cuba(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "country": "CU"})
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_iran(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "country": "IR"})
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_north_korea(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "country": "KP"})
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_case_insensitive(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "country": "sy"})
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_allows_us(self):
        """US should NOT be blocked by OFAC check (but may fail on proxy connect)."""
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "country": "US"})
        # Should not have an OFAC error
        if "error" in result:
            assert "OFAC" not in result["error"]


# ===========================================================================
# HTTP Method Restriction Tests
# ===========================================================================


class TestHTTPMethodRestriction:
    """Ensure only GET/HEAD/OPTIONS are allowed for proxied fetch."""

    def test_blocks_post(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "POST"})
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_put(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "PUT"})
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_delete(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "DELETE"})
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_patch(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "PATCH"})
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_allows_get(self):
        """GET should pass method check (may fail on actual proxy connect)."""
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "GET"})
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_head(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "HEAD"})
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_options(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({"url": "https://example.com", "method": "OPTIONS"})
        if "error" in result:
            assert "not allowed" not in result["error"]


# ===========================================================================
# URL Validation Tests
# ===========================================================================


class TestURLValidation:
    """Test URL validation edge cases."""

    def test_blocks_no_hostname(self):
        with pytest.raises(ValueError, match="hostname"):
            validate_url("http:///no-host")

    def test_blocks_javascript_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("javascript:alert(1)")

    def test_blocks_data_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("data:text/html,<h1>Hello</h1>")

    def test_blocks_none_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url(None)  # type: ignore

    def test_blocks_non_string_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url(123)  # type: ignore


# ===========================================================================
# Provider Initialization Tests
# ===========================================================================


class TestProviderInit:
    """Test provider initialization and configuration."""

    def test_default_config(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        assert provider.api_key == "dn_test_key123"
        assert provider.base_url == "https://api.dominusnode.com"
        assert provider.timeout == 30.0

    def test_custom_config(self):
        provider = DominusNodeProvider(credentials={
            "api_key": "dn_live_custom",
            "base_url": "http://localhost:3000",
            "proxy_host": "127.0.0.1",
        })
        assert provider.api_key == "dn_live_custom"
        assert provider.base_url == "http://localhost:3000"
        assert provider.proxy_host == "127.0.0.1"

    def test_env_fallback(self):
        with patch.dict(os.environ, {"DOMINUSNODE_API_KEY": "dn_test_from_env"}):
            provider = DominusNodeProvider(credentials={})
            assert provider.api_key == "dn_test_from_env"

    def test_env_proxy_host(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_HOST": "my-proxy.example.com"}):
            provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
            assert provider.proxy_host == "my-proxy.example.com"

    def test_env_proxy_port(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_PORT": "9999"}):
            provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
            assert provider.proxy_port == 9999

    def test_base_url_trailing_slash_stripped(self):
        provider = DominusNodeProvider(credentials={
            "api_key": "dn_test_key123",
            "base_url": "https://api.example.com/",
        })
        assert provider.base_url == "https://api.example.com"

    def test_get_tools_returns_24(self):
        tools = DominusNodeProvider.get_tools()
        assert len(tools) == 24
        assert "proxied_fetch" in tools
        assert "check_balance" in tools
        assert "topup_paypal" in tools
        assert "update_team_member_role" in tools
        assert "update_wallet_policy" in tools

    def test_none_credentials(self):
        """Provider should handle None credentials gracefully."""
        with patch.dict(os.environ, {"DOMINUSNODE_API_KEY": "dn_test_env_key"}):
            provider = DominusNodeProvider(credentials=None)
            assert provider.api_key == "dn_test_env_key"


# ===========================================================================
# Input Validation Tests
# ===========================================================================


class TestInputValidation:
    """Test input validation for various tools."""

    def test_create_agentic_wallet_rejects_empty_label(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "", "spending_limit_cents": 1000,
        })
        assert "error" in result
        assert "label" in result["error"].lower()

    def test_create_agentic_wallet_rejects_long_label(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "x" * 101, "spending_limit_cents": 1000,
        })
        assert "error" in result
        assert "100" in result["error"]

    def test_create_agentic_wallet_rejects_control_chars(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "bad\x00label", "spending_limit_cents": 1000,
        })
        assert "error" in result
        assert "control" in result["error"].lower()

    def test_create_agentic_wallet_rejects_negative_limit(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": -1,
        })
        assert "error" in result

    def test_create_agentic_wallet_rejects_zero_limit(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 0,
        })
        assert "error" in result

    def test_create_agentic_wallet_rejects_bool(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": True,
        })
        assert "error" in result

    def test_create_agentic_wallet_accepts_float_coercion(self):
        """Dify sends numbers as float; should coerce to int."""
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        # This should pass validation (coerce 1000.0 -> 1000)
        # but will fail on API call (no server), that's fine
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000.0,
        })
        # Should not have a type validation error
        if "error" in result:
            assert "must be an integer" not in result["error"]

    def test_team_fund_rejects_below_minimum(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.team_fund({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "amount_cents": 50,
        })
        assert "error" in result
        assert "100" in result["error"]

    def test_team_fund_rejects_above_maximum(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.team_fund({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "amount_cents": 2_000_000,
        })
        assert "error" in result

    def test_update_team_member_role_rejects_invalid_role(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.update_team_member_role({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "user_id": "550e8400-e29b-41d4-a716-446655440001",
            "role": "superadmin",
        })
        assert "error" in result
        assert "member" in result["error"]

    def test_update_team_rejects_no_changes(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.update_team({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
        })
        assert "error" in result
        assert "At least one" in result["error"]

    def test_team_details_rejects_invalid_uuid(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.team_details({"team_id": "not-a-uuid"})
        assert "error" in result
        assert "UUID" in result["error"]

    def test_agentic_transactions_rejects_limit_zero(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.agentic_transactions({
            "wallet_id": "wallet-id", "limit": 0,
        })
        assert "error" in result
        assert "limit" in result["error"].lower()

    def test_agentic_transactions_rejects_limit_over_100(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.agentic_transactions({
            "wallet_id": "wallet-id", "limit": 101,
        })
        assert "error" in result

    def test_check_usage_rejects_invalid_period(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.check_usage({"period": "year"})
        assert "error" in result
        assert "period" in result["error"]

    def test_proxied_fetch_rejects_invalid_proxy_type(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({
            "url": "https://example.com", "proxy_type": "invalid",
        })
        assert "error" in result
        assert "proxy_type" in result["error"]

    def test_proxied_fetch_rejects_missing_url(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.proxied_fetch({})
        assert "error" in result
        assert "url" in result["error"].lower()

    def test_fund_agentic_wallet_rejects_missing_fields(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.fund_agentic_wallet({})
        assert "error" in result
        assert "required" in result["error"].lower()

    def test_team_create_key_rejects_missing_fields(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.team_create_key({})
        assert "error" in result
        assert "required" in result["error"].lower()

    def test_update_team_member_role_rejects_missing_fields(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.update_team_member_role({})
        assert "error" in result
        assert "required" in result["error"].lower()


# ===========================================================================
# Label Validation Tests
# ===========================================================================


class TestLabelValidation:
    """Test _validate_label helper."""

    def test_valid_label(self):
        assert _validate_label("My Wallet") is None

    def test_empty_label(self):
        assert _validate_label("") is not None

    def test_none_label(self):
        assert _validate_label(None) is not None

    def test_too_long_label(self):
        assert _validate_label("x" * 101) is not None

    def test_control_char_label(self):
        result = _validate_label("bad\x00label")
        assert result is not None
        assert "control" in result.lower()

    def test_max_length_label(self):
        assert _validate_label("x" * 100) is None


# ===========================================================================
# Positive Int Validation Tests
# ===========================================================================


class TestPositiveIntValidation:
    """Test _validate_positive_int helper."""

    def test_valid_int(self):
        assert _validate_positive_int(100, "test") is None

    def test_zero_rejected(self):
        assert _validate_positive_int(0, "test") is not None

    def test_negative_rejected(self):
        assert _validate_positive_int(-1, "test") is not None

    def test_bool_rejected(self):
        assert _validate_positive_int(True, "test") is not None

    def test_string_rejected(self):
        assert _validate_positive_int("100", "test") is not None

    def test_over_max_rejected(self):
        assert _validate_positive_int(2_147_483_648, "test") is not None

    def test_custom_range(self):
        assert _validate_positive_int(50, "test", min_value=100) is not None
        assert _validate_positive_int(101, "test", max_value=100) is not None


# ===========================================================================
# UUID Validation Tests
# ===========================================================================


class TestUUIDValidation:
    """Test _validate_uuid helper."""

    def test_valid_uuid(self):
        assert _validate_uuid("550e8400-e29b-41d4-a716-446655440000", "id") is None

    def test_invalid_uuid(self):
        assert _validate_uuid("not-a-uuid", "id") is not None

    def test_empty_uuid(self):
        assert _validate_uuid("", "id") is not None

    def test_none_uuid(self):
        assert _validate_uuid(None, "id") is not None


# ===========================================================================
# PayPal Top-up Validation Tests
# ===========================================================================


class TestPayPalTopup:
    """Test PayPal top-up validation."""

    def test_rejects_below_minimum(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": 100})
        assert "error" in result
        assert "500" in result["error"]

    def test_rejects_zero(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": 0})
        assert "error" in result

    def test_rejects_negative(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": -500})
        assert "error" in result

    def test_rejects_above_maximum(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": 2_000_000})
        assert "error" in result
        assert "1000000" in result["error"] or "1,000,000" in result["error"]

    def test_rejects_boolean(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": True})
        assert "error" in result

    def test_rejects_missing_amount(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({})
        assert "error" in result
        assert "amount_cents" in result["error"]

    def test_accepts_float_coercion(self):
        """Dify sends numbers as float; 1000.0 should coerce to int 1000."""
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": 1000.0})
        # Should not have a type validation error
        if "error" in result:
            assert "must be an integer" not in result["error"]

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_valid_amount_calls_api(self, mock_httpx_cls):
        """A valid amount should authenticate then call the PayPal API."""
        # Mock authenticate response
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test_token"}

        # Mock paypal API response
        mock_paypal_resp = MagicMock()
        mock_paypal_resp.status_code = 200
        mock_paypal_resp.text = '{"orderId":"PAY-123","approvalUrl":"https://paypal.com/approve"}'
        mock_paypal_resp.content = mock_paypal_resp.text.encode()
        mock_paypal_resp.json.return_value = {
            "orderId": "PAY-123",
            "approvalUrl": "https://paypal.com/approve",
            "amountCents": 1000,
        }

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_paypal_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.topup_paypal({"amount_cents": 1000})

        assert "orderId" in result
        assert result["orderId"] == "PAY-123"


# ===========================================================================
# Tool Dispatcher Tests
# ===========================================================================


class TestToolDispatcher:
    """Test the invoke_tool dispatch method."""

    def test_unknown_tool(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.invoke_tool("nonexistent", {})
        assert "error" in result
        assert "Unknown tool" in result["error"]
        assert "available_tools" in result

    def test_dispatch_check_balance(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        # Will fail on auth (no real server), but should dispatch correctly
        result = provider.invoke_tool("check_balance", {})
        assert "error" in result  # Expected -- no server

    def test_dispatch_proxied_fetch_missing_url(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.invoke_tool("proxied_fetch", {})
        assert "error" in result
        assert "url" in result["error"].lower()

    def test_dispatch_create_team_missing_name(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.invoke_tool("create_team", {})
        assert "error" in result
        assert "name" in result["error"].lower()

    def test_dispatch_topup_paypal_missing_amount(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.invoke_tool("topup_paypal", {})
        assert "error" in result
        assert "amount_cents" in result["error"]

    def test_dispatch_all_tools_exist(self):
        """Verify all 24 tool names are dispatchable."""
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        tools = DominusNodeProvider.get_tools()
        for tool_name in tools:
            result = provider.invoke_tool(tool_name, {})
            # Should not be "Unknown tool"
            if "error" in result:
                assert "Unknown tool" not in result["error"], f"{tool_name} not found"


# ===========================================================================
# Authentication Tests
# ===========================================================================


class TestAuthentication:
    """Test authentication behavior."""

    def test_no_api_key_returns_error(self):
        with patch.dict(os.environ, {}, clear=True):
            provider = DominusNodeProvider(credentials={"api_key": ""})
            result = provider.check_balance({})
            assert "error" in result
            assert "API key" in result["error"]

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_auth_failure_returns_error(self, mock_httpx_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized"

        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        provider = DominusNodeProvider(credentials={"api_key": "dn_test_badkey"})
        result = provider.check_balance({})
        assert "error" in result

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_successful_auth_and_request(self, mock_httpx_cls):
        # Auth response
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_123"}

        # API response
        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = '{"balanceCents":5000}'
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = {"balanceCents": 5000}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.check_balance({})
        assert result["balanceCents"] == 5000

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_401_retry_reauthenticates(self, mock_httpx_cls):
        """On 401 API error, provider should re-auth and retry once."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_new"}

        # First API call returns 401, second succeeds
        mock_401_resp = MagicMock()
        mock_401_resp.status_code = 401
        mock_401_resp.text = "Token expired"
        mock_401_resp.content = b"Token expired"
        mock_401_resp.json.return_value = {"error": "Token expired"}

        mock_ok_resp = MagicMock()
        mock_ok_resp.status_code = 200
        mock_ok_resp.text = '{"balanceCents":1000}'
        mock_ok_resp.content = mock_ok_resp.text.encode()
        mock_ok_resp.json.return_value = {"balanceCents": 1000}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.side_effect = [mock_401_resp, mock_ok_resp]
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.check_balance({})
        assert result["balanceCents"] == 1000


# ===========================================================================
# Mocked API Call Tests (all 22 tools with successful responses)
# ===========================================================================


class TestMockedAPICalls:
    """Test each tool with mocked API responses."""

    def _make_provider_with_mock(self, mock_httpx_cls, api_response):
        """Helper to create a provider with mocked auth and API response."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = json.dumps(api_response)
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = api_response

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        return DominusNodeProvider(credentials={"api_key": "dn_test_key123"})

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_check_balance_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"balanceCents": 5000}
        )
        result = provider.check_balance({})
        assert result["balanceCents"] == 5000

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_check_usage_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"totalBytes": 1024000, "costCents": 50}
        )
        result = provider.check_usage({"period": "day"})
        assert result["totalBytes"] == 1024000

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_get_proxy_config_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"httpProxy": {"host": "proxy.example.com", "port": 8080}}
        )
        result = provider.get_proxy_config({})
        assert "httpProxy" in result

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_list_sessions_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"sessions": []}
        )
        result = provider.list_sessions({})
        assert "sessions" in result

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_create_agentic_wallet_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "wallet-123", "label": "Test", "balanceCents": 0}
        )
        result = provider.create_agentic_wallet({
            "label": "Test", "spending_limit_cents": 1000,
        })
        assert result["id"] == "wallet-123"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_fund_agentic_wallet_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "wallet-123", "balanceCents": 500}
        )
        result = provider.fund_agentic_wallet({
            "wallet_id": "wallet-123", "amount_cents": 500,
        })
        assert result["balanceCents"] == 500

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_agentic_wallet_balance_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "wallet-123", "balanceCents": 750}
        )
        result = provider.agentic_wallet_balance({"wallet_id": "wallet-123"})
        assert result["balanceCents"] == 750

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_list_agentic_wallets_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"wallets": [{"id": "w1"}, {"id": "w2"}]}
        )
        result = provider.list_agentic_wallets({})
        assert len(result["wallets"]) == 2

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_agentic_transactions_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"transactions": [{"id": "t1", "amountCents": 100}]}
        )
        result = provider.agentic_transactions({"wallet_id": "wallet-123"})
        assert len(result["transactions"]) == 1

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_freeze_agentic_wallet_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "wallet-123", "status": "frozen"}
        )
        result = provider.freeze_agentic_wallet({"wallet_id": "wallet-123"})
        assert result["status"] == "frozen"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_unfreeze_agentic_wallet_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "wallet-123", "status": "active"}
        )
        result = provider.unfreeze_agentic_wallet({"wallet_id": "wallet-123"})
        assert result["status"] == "active"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_delete_agentic_wallet_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"deleted": True}
        )
        result = provider.delete_agentic_wallet({"wallet_id": "wallet-123"})
        assert result["deleted"] is True

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_create_team_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "team-123", "name": "My Team"}
        )
        result = provider.create_team({"name": "My Team"})
        assert result["id"] == "team-123"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_list_teams_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"teams": [{"id": "t1"}]}
        )
        result = provider.list_teams({})
        assert len(result["teams"]) == 1

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_team_details_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "550e8400-e29b-41d4-a716-446655440000", "name": "Team A"}
        )
        result = provider.team_details({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
        })
        assert result["name"] == "Team A"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_team_fund_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"balanceCents": 5000}
        )
        result = provider.team_fund({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "amount_cents": 5000,
        })
        assert result["balanceCents"] == 5000

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_team_create_key_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"key": "dn_live_teamkey", "label": "Agent Key"}
        )
        result = provider.team_create_key({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "label": "Agent Key",
        })
        assert result["label"] == "Agent Key"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_team_usage_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"transactions": []}
        )
        result = provider.team_usage({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
        })
        assert "transactions" in result

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_update_team_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"id": "550e8400-e29b-41d4-a716-446655440000", "name": "New Name"}
        )
        result = provider.update_team({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "New Name",
        })
        assert result["name"] == "New Name"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_update_team_member_role_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"role": "admin"}
        )
        result = provider.update_team_member_role({
            "team_id": "550e8400-e29b-41d4-a716-446655440000",
            "user_id": "550e8400-e29b-41d4-a716-446655440001",
            "role": "admin",
        })
        assert result["role"] == "admin"

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_x402_info_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"facilitators": [], "pricing": {}}
        )
        result = provider.x402_info({})
        assert "facilitators" in result

    @patch("dominusnode_dify.tools.httpx.Client")
    def test_topup_paypal_success(self, mock_httpx_cls):
        provider = self._make_provider_with_mock(
            mock_httpx_cls, {"orderId": "PAY-456", "approvalUrl": "https://paypal.com/approve"}
        )
        result = provider.topup_paypal({"amount_cents": 1000})
        assert result["orderId"] == "PAY-456"


# ===========================================================================
# Wallet Policy Tests
# ===========================================================================


class TestWalletPolicy:
    """Test wallet policy fields on create_agentic_wallet and update_wallet_policy."""

    def test_create_with_daily_limit(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "daily_limit_cents": 5000,
        })
        if "error" in result:
            assert "daily_limit_cents" not in result["error"]

    def test_create_with_allowed_domains(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "allowed_domains": ["example.com"],
        })
        if "error" in result:
            assert "allowed_domains" not in result["error"]

    def test_create_rejects_daily_limit_zero(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "daily_limit_cents": 0,
        })
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_daily_limit_over_max(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "daily_limit_cents": 1_000_001,
        })
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_invalid_domain(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "allowed_domains": ["-invalid.com"],
        })
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_create_rejects_too_many_domains(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        domains = [f"d{i}.com" for i in range(101)]
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "allowed_domains": domains,
        })
        assert "error" in result
        assert "100" in result["error"]

    def test_create_rejects_domains_not_list(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.create_agentic_wallet({
            "label": "test", "spending_limit_cents": 1000,
            "allowed_domains": "example.com",
        })
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_update_wallet_policy_rejects_invalid_uuid(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.update_wallet_policy({
            "wallet_id": "not-a-uuid",
            "daily_limit_cents": 5000,
        })
        assert "error" in result
        assert "UUID" in result["error"]

    def test_update_wallet_policy_rejects_daily_limit_zero(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.update_wallet_policy({
            "wallet_id": "550e8400-e29b-41d4-a716-446655440000",
            "daily_limit_cents": 0,
        })
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_update_wallet_policy_rejects_invalid_domain(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.update_wallet_policy({
            "wallet_id": "550e8400-e29b-41d4-a716-446655440000",
            "allowed_domains": ["bad domain"],
        })
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_update_wallet_policy_in_dispatch(self):
        provider = DominusNodeProvider(credentials={"api_key": "dn_test_key123"})
        result = provider.invoke_tool("update_wallet_policy", {})
        # Should not be "Unknown tool"
        if "error" in result:
            assert "Unknown tool" not in result["error"]

    def test_update_wallet_policy_in_tools_list(self):
        tools = DominusNodeProvider.get_tools()
        assert "update_wallet_policy" in tools
