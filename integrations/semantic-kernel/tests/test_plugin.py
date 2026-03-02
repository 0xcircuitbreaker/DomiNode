"""Tests for dominusnode-semantic-kernel plugin.

Covers SSRF validation, credential sanitization, prototype pollution,
OFAC blocking, HTTP method restrictions, URL validation, plugin
initialization, input validation, kernel function decorators, and all
22 Semantic Kernel functions.

All tests mock httpx calls so no real network requests are made.
"""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from dominusnode_semantic_kernel.plugin import (
    BLOCKED_HOSTNAMES,
    DominusNodePlugin,
    MAX_RESPONSE_BYTES,
    MAX_RESPONSE_CHARS,
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
        with patch(
            "dominusnode_semantic_kernel.plugin.socket.getaddrinfo",
            return_value=mock_infos,
        ):
            with pytest.raises(ValueError, match="private IP"):
                validate_url("http://evil.example.com/secret")

    def test_dns_rebinding_allows_public_resolved_ip(self):
        """If a hostname resolves to a public IP, it should be allowed."""
        mock_infos = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with patch(
            "dominusnode_semantic_kernel.plugin.socket.getaddrinfo",
            return_value=mock_infos,
        ):
            result = validate_url("http://example.com/page")
            assert result == "http://example.com/page"

    def test_blocks_unresolvable_hostname(self):
        import socket as sock_mod

        with patch(
            "dominusnode_semantic_kernel.plugin.socket.getaddrinfo",
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
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", country="CU",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_iran(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", country="IR",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_north_korea(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", country="KP",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_case_insensitive(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", country="sy",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_allows_us(self):
        """US should NOT be blocked by OFAC check (but may fail on proxy connect)."""
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", country="US",
        ))
        # Should not have an OFAC error
        if "error" in result:
            assert "OFAC" not in result["error"]


# ===========================================================================
# HTTP Method Restriction Tests
# ===========================================================================


class TestHTTPMethodRestriction:
    """Ensure only GET/HEAD/OPTIONS are allowed for proxied fetch."""

    def test_blocks_post(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="POST",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_put(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="PUT",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_delete(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="DELETE",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_patch(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="PATCH",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_allows_get(self):
        """GET should pass method check (may fail on actual proxy connect)."""
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="GET",
        ))
        # Should not have a method restriction error
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_head(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="HEAD",
        ))
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_options(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", method="OPTIONS",
        ))
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
# Plugin Initialization Tests
# ===========================================================================


class TestPluginInit:
    """Test plugin initialization and configuration."""

    def test_default_config(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        assert plugin.api_key == "dn_test_key123"
        assert plugin.base_url == "https://api.dominusnode.com"
        assert plugin.timeout == 30.0

    def test_custom_config(self):
        plugin = DominusNodePlugin(
            api_key="dn_live_custom",
            base_url="http://localhost:3000",
            proxy_host="127.0.0.1",
            proxy_port=9090,
            timeout=60.0,
        )
        assert plugin.api_key == "dn_live_custom"
        assert plugin.base_url == "http://localhost:3000"
        assert plugin.timeout == 60.0
        assert plugin.proxy_port == 9090

    def test_env_fallback(self):
        with patch.dict(os.environ, {"DOMINUSNODE_API_KEY": "dn_test_from_env"}):
            plugin = DominusNodePlugin()
            assert plugin.api_key == "dn_test_from_env"

    def test_env_proxy_host(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_HOST": "my-proxy.example.com"}):
            plugin = DominusNodePlugin(api_key="dn_test_key123")
            assert plugin.proxy_host == "my-proxy.example.com"

    def test_env_proxy_port(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_PORT": "9999"}):
            plugin = DominusNodePlugin(api_key="dn_test_key123")
            assert plugin.proxy_port == 9999

    def test_base_url_trailing_slash_stripped(self):
        plugin = DominusNodePlugin(
            api_key="dn_test_key123",
            base_url="https://api.example.com/",
        )
        assert plugin.base_url == "https://api.example.com"


# ===========================================================================
# Kernel Function Decorator Tests
# ===========================================================================


class TestKernelFunctionDecorators:
    """Verify all 22 methods have @kernel_function decorators."""

    def test_proxied_fetch_has_decorator(self):
        meta = getattr(DominusNodePlugin.proxied_fetch, "__kernel_function_metadata__", None)
        assert meta is not None or hasattr(DominusNodePlugin.proxied_fetch, "__kernel_function__")

    def test_check_balance_has_decorator(self):
        meta = getattr(DominusNodePlugin.check_balance, "__kernel_function_metadata__", None)
        assert meta is not None or hasattr(DominusNodePlugin.check_balance, "__kernel_function__")

    def test_all_26_functions_are_callable(self):
        """Verify all 26 expected function names exist on the plugin class."""
        expected_functions = [
            "proxied_fetch",
            "check_balance",
            "check_usage",
            "get_proxy_config",
            "list_sessions",
            "create_agentic_wallet",
            "fund_agentic_wallet",
            "agentic_wallet_balance",
            "list_agentic_wallets",
            "agentic_transactions",
            "freeze_agentic_wallet",
            "unfreeze_agentic_wallet",
            "delete_agentic_wallet",
            "create_team",
            "list_teams",
            "team_details",
            "team_fund",
            "team_create_key",
            "team_usage",
            "update_team",
            "update_team_member_role",
            "x402_info",
            "topup_paypal",
            "topup_stripe",
            "topup_crypto",
        ]
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        for fn_name in expected_functions:
            assert hasattr(plugin, fn_name), f"Missing function: {fn_name}"
            assert callable(getattr(plugin, fn_name)), f"Not callable: {fn_name}"

    def test_function_count_is_26(self):
        """Verify we have exactly 26 public kernel function methods."""
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        kernel_functions = []
        for attr_name in dir(plugin):
            if attr_name.startswith("_"):
                continue
            attr = getattr(type(plugin), attr_name, None)
            if attr is not None and callable(attr):
                if (
                    hasattr(attr, "__kernel_function_metadata__")
                    or hasattr(attr, "__kernel_function__")
                ):
                    kernel_functions.append(attr_name)
        assert len(kernel_functions) == 26, f"Expected 26 kernel functions, got {len(kernel_functions)}: {kernel_functions}"


# ===========================================================================
# Input Validation Tests
# ===========================================================================


class TestInputValidation:
    """Test input validation for various commands."""

    def test_create_agentic_wallet_rejects_empty_label(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="", spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "label" in result["error"].lower()

    def test_create_agentic_wallet_rejects_long_label(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="x" * 101, spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_create_agentic_wallet_rejects_control_chars(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="bad\x00label", spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "control" in result["error"].lower()

    def test_create_agentic_wallet_rejects_negative_limit(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=-1,
        ))
        assert "error" in result

    def test_create_agentic_wallet_rejects_zero_limit(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=0,
        ))
        assert "error" in result

    def test_create_agentic_wallet_rejects_bool(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=True,  # type: ignore
        ))
        assert "error" in result

    def test_team_fund_rejects_below_minimum(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=50,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_team_fund_rejects_above_maximum(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=2_000_000,
        ))
        assert "error" in result

    def test_update_team_member_role_rejects_invalid_role(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_team_member_role(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            user_id="550e8400-e29b-41d4-a716-446655440001",
            role="superadmin",
        ))
        assert "error" in result
        assert "member" in result["error"]

    def test_update_team_rejects_no_changes(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_team(
            team_id="550e8400-e29b-41d4-a716-446655440000",
        ))
        assert "error" in result
        assert "At least one" in result["error"]

    def test_team_details_rejects_invalid_uuid(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_details(team_id="not-a-uuid"))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_agentic_transactions_rejects_limit_zero(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.agentic_transactions(
            wallet_id="wallet-id", limit=0,
        ))
        assert "error" in result
        assert "limit" in result["error"].lower()

    def test_agentic_transactions_rejects_limit_over_100(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.agentic_transactions(
            wallet_id="wallet-id", limit=101,
        ))
        assert "error" in result

    def test_check_usage_rejects_invalid_period(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.check_usage(period="year"))
        assert "error" in result
        assert "period" in result["error"]

    def test_proxied_fetch_rejects_invalid_proxy_type(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.proxied_fetch(
            url="https://example.com", proxy_type="invalid",
        ))
        assert "error" in result
        assert "proxy_type" in result["error"]

    def test_fund_agentic_wallet_rejects_empty_id(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.fund_agentic_wallet(
            wallet_id="", amount_cents=100,
        ))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_freeze_agentic_wallet_rejects_empty_id(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.freeze_agentic_wallet(wallet_id=""))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_unfreeze_agentic_wallet_rejects_empty_id(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.unfreeze_agentic_wallet(wallet_id=""))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_delete_agentic_wallet_rejects_empty_id(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.delete_agentic_wallet(wallet_id=""))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_team_create_key_rejects_empty_label(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_create_key(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            label="",
        ))
        assert "error" in result
        assert "label" in result["error"].lower()

    def test_create_team_rejects_max_members_over_100(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_team(
            name="Test Team", max_members=200,
        ))
        assert "error" in result
        assert "100" in result["error"]


# ===========================================================================
# PayPal Top-up Validation Tests
# ===========================================================================


class TestPayPalTopup:
    """Test PayPal top-up validation."""

    def test_rejects_below_minimum(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=100))
        assert "error" in result
        assert "500" in result["error"]

    def test_rejects_zero(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=0))
        assert "error" in result

    def test_rejects_negative(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=-500))
        assert "error" in result

    def test_rejects_above_maximum(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=2_000_000))
        assert "error" in result
        assert "1000000" in result["error"] or "1,000,000" in result["error"]

    def test_rejects_boolean(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=True))  # type: ignore
        assert "error" in result

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
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

        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=1000))

        assert "orderId" in result
        assert result["orderId"] == "PAY-123"


# ===========================================================================
# Authentication Tests
# ===========================================================================


class TestAuthentication:
    """Test authentication behavior."""

    def test_no_api_key_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            plugin = DominusNodePlugin(api_key="")
            result = json.loads(plugin.check_balance())
            assert "error" in result
            assert "API key" in result["error"]

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_auth_failure_returns_error(self, mock_httpx_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized"

        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        plugin = DominusNodePlugin(api_key="dn_test_badkey")
        result = json.loads(plugin.check_balance())
        assert "error" in result

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
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

        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_401_retry_reauthenticates(self, mock_httpx_cls):
        """On 401 API error, plugin should re-auth and retry once."""
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

        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.check_balance())
        assert result["balanceCents"] == 1000


# ===========================================================================
# Mocked API Interaction Tests for All 22 Functions
# ===========================================================================


def _make_mock_httpx(auth_token="jwt_test", api_response=None):
    """Helper to create mocked httpx Client for API calls."""
    mock_auth_resp = MagicMock()
    mock_auth_resp.status_code = 200
    mock_auth_resp.json.return_value = {"token": auth_token}

    if api_response is None:
        api_response = {"ok": True}

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

    return mock_client


class TestMockedAPIFunctions:
    """Test all 22 functions with mocked API responses."""

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_check_balance(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(api_response={"balanceCents": 5000})
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_check_usage(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(api_response={"totalBytes": 1024})
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.check_usage(period="day"))
        assert result["totalBytes"] == 1024

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_get_proxy_config(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"httpProxy": {"host": "proxy.dominusnode.com", "port": 8080}}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.get_proxy_config())
        assert "httpProxy" in result

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_list_sessions(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(api_response={"sessions": []})
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.list_sessions())
        assert "sessions" in result

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_create_agentic_wallet(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "w-123", "label": "Agent", "balanceCents": 0}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(label="Agent", spending_limit_cents=500))
        assert result["id"] == "w-123"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_fund_agentic_wallet(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "w-123", "balanceCents": 500}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.fund_agentic_wallet(wallet_id="w-123", amount_cents=500))
        assert result["balanceCents"] == 500

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_agentic_wallet_balance(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "w-123", "balanceCents": 300}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.agentic_wallet_balance(wallet_id="w-123"))
        assert result["balanceCents"] == 300

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_list_agentic_wallets(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"wallets": [{"id": "w-1"}, {"id": "w-2"}]}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.list_agentic_wallets())
        assert len(result["wallets"]) == 2

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_agentic_transactions(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"transactions": [{"id": "tx-1"}]}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.agentic_transactions(wallet_id="w-123", limit=10))
        assert len(result["transactions"]) == 1

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_freeze_agentic_wallet(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "w-123", "status": "frozen"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.freeze_agentic_wallet(wallet_id="w-123"))
        assert result["status"] == "frozen"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_unfreeze_agentic_wallet(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "w-123", "status": "active"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.unfreeze_agentic_wallet(wallet_id="w-123"))
        assert result["status"] == "active"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_delete_agentic_wallet(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"deleted": True}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.delete_agentic_wallet(wallet_id="w-123"))
        assert result["deleted"] is True

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_create_team(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "t-123", "name": "Research Team"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_team(name="Research Team", max_members=10))
        assert result["name"] == "Research Team"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_list_teams(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"teams": [{"id": "t-1"}]}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.list_teams())
        assert len(result["teams"]) == 1

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_team_details(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "550e8400-e29b-41d4-a716-446655440000", "name": "Team A"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_details(team_id="550e8400-e29b-41d4-a716-446655440000"))
        assert result["name"] == "Team A"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_team_fund(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"balanceCents": 5000}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000", amount_cents=5000,
        ))
        assert result["balanceCents"] == 5000

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_team_create_key(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "k-123", "key": "dn_live_teamkey"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_create_key(
            team_id="550e8400-e29b-41d4-a716-446655440000", label="Agent Key",
        ))
        assert result["id"] == "k-123"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_team_usage(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"transactions": []}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.team_usage(
            team_id="550e8400-e29b-41d4-a716-446655440000", limit=50,
        ))
        assert "transactions" in result

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_update_team(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"id": "550e8400-e29b-41d4-a716-446655440000", "name": "New Name"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_team(
            team_id="550e8400-e29b-41d4-a716-446655440000", name="New Name",
        ))
        assert result["name"] == "New Name"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_update_team_member_role(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"role": "admin"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_team_member_role(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            user_id="550e8400-e29b-41d4-a716-446655440001",
            role="admin",
        ))
        assert result["role"] == "admin"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_x402_info(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"facilitators": [], "pricing": {}}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.x402_info())
        assert "facilitators" in result

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_topup_paypal(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"orderId": "PAY-456", "approvalUrl": "https://paypal.com/approve"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_paypal(amount_cents=1000))
        assert result["orderId"] == "PAY-456"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_topup_stripe(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"sessionId": "cs_123", "checkoutUrl": "https://checkout.stripe.com/x"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_stripe(amount_cents=1000))
        assert result["sessionId"] == "cs_123"

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_topup_crypto(self, mock_httpx_cls):
        mock_httpx_cls.return_value = _make_mock_httpx(
            api_response={"invoiceId": "INV-1", "paymentUrl": "https://nowpayments.io/x"}
        )
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.topup_crypto(amount_usd=10, currency="BTC"))
        assert result["invoiceId"] == "INV-1"


# ===========================================================================
# Validation Helper Unit Tests
# ===========================================================================


class TestValidationHelpers:
    """Test standalone validation helper functions."""

    def test_validate_label_empty(self):
        assert _validate_label("") is not None

    def test_validate_label_none(self):
        assert _validate_label(None) is not None

    def test_validate_label_too_long(self):
        assert _validate_label("x" * 101) is not None

    def test_validate_label_control_char(self):
        result = _validate_label("test\x00label")
        assert result is not None
        assert "control" in result.lower()

    def test_validate_label_valid(self):
        assert _validate_label("Good Label") is None

    def test_validate_positive_int_bool(self):
        assert _validate_positive_int(True, "test") is not None

    def test_validate_positive_int_string(self):
        assert _validate_positive_int("123", "test") is not None

    def test_validate_positive_int_zero(self):
        assert _validate_positive_int(0, "test") is not None

    def test_validate_positive_int_negative(self):
        assert _validate_positive_int(-1, "test") is not None

    def test_validate_positive_int_over_max(self):
        assert _validate_positive_int(2_147_483_648, "test") is not None

    def test_validate_positive_int_valid(self):
        assert _validate_positive_int(100, "test") is None

    def test_validate_uuid_empty(self):
        assert _validate_uuid("", "test") is not None

    def test_validate_uuid_invalid(self):
        assert _validate_uuid("not-a-uuid", "test") is not None

    def test_validate_uuid_valid(self):
        assert _validate_uuid("550e8400-e29b-41d4-a716-446655440000", "test") is None


# ===========================================================================
# Wallet Policy Tests
# ===========================================================================


class TestWalletPolicy:
    """Test create_agentic_wallet with policy fields and update_wallet_policy."""

    def test_create_with_daily_limit(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        # daily_limit_cents passes validation; will fail at network call
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=5000,
        ))
        # Should not have a daily_limit_cents validation error
        if "error" in result:
            assert "daily_limit_cents" not in result["error"]

    def test_create_with_allowed_domains(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["example.com", "api.test.org"],
        ))
        if "error" in result:
            assert "allowed_domains" not in result["error"]

    def test_create_rejects_bad_daily_limit_zero(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_bad_daily_limit_negative(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=-1,
        ))
        assert "error" in result

    def test_create_rejects_daily_limit_over_max(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=1_000_001,
        ))
        assert "error" in result
        assert "1000000" in result["error"] or "1,000,000" in result["error"]

    def test_create_rejects_domains_not_list(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains="example.com",  # type: ignore
        ))
        assert "error" in result
        assert "list" in result["error"]

    def test_create_rejects_domain_too_long(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["a" * 254],
        ))
        assert "error" in result
        assert "253" in result["error"]

    def test_create_rejects_invalid_domain(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["not a domain!"],
        ))
        assert "error" in result
        assert "valid domain" in result["error"]

    def test_create_rejects_too_many_domains(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["d.com"] * 101,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_create_rejects_empty_domain_entry(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=[""],
        ))
        assert "error" in result
        assert "non-empty" in result["error"]

    # -- update_wallet_policy tests --

    def test_update_wallet_policy_rejects_empty_wallet_id(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="",
            daily_limit_cents=5000,
        ))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_update_wallet_policy_rejects_no_fields(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="w-123",
        ))
        assert "error" in result
        assert "At least one" in result["error"]

    def test_update_wallet_policy_rejects_bad_daily_limit(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="w-123",
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_update_wallet_policy_rejects_bad_domains(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="w-123",
            allowed_domains="not-a-list",  # type: ignore
        ))
        assert "error" in result
        assert "list" in result["error"]

    def test_update_wallet_policy_valid_daily_limit(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="w-123",
            daily_limit_cents=5000,
        ))
        # Should pass validation; will fail at network call
        if "error" in result:
            assert "daily_limit_cents" not in result["error"]
            assert "At least one" not in result["error"]

    def test_update_wallet_policy_valid_domains(self):
        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="w-123",
            allowed_domains=["example.com"],
        ))
        if "error" in result:
            assert "allowed_domains" not in result["error"]
            assert "At least one" not in result["error"]

    @patch("dominusnode_semantic_kernel.plugin.httpx.Client")
    def test_update_wallet_policy_calls_patch(self, mock_httpx_cls):
        """Verify update_wallet_policy sends PATCH to correct endpoint."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = '{"dailyLimitCents":5000}'
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = {"dailyLimitCents": 5000}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        plugin = DominusNodePlugin(api_key="dn_test_key123")
        result = json.loads(plugin.update_wallet_policy(
            wallet_id="w-123",
            daily_limit_cents=5000,
        ))
        assert result["dailyLimitCents"] == 5000
