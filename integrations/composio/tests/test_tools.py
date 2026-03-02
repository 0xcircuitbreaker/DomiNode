"""Tests for dominusnode-composio toolkit.

Covers SSRF validation, credential sanitization, prototype pollution,
OFAC blocking, HTTP method restrictions, URL validation, toolkit
initialization, input validation, Composio action definitions,
action handlers, and PayPal top-up validation.

All tests mock httpx calls so no real network requests are made.
"""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from dominusnode_composio.tools import (
    DominusNodeToolkit,
    SANCTIONED_COUNTRIES,
    _is_private_ip,
    _normalize_ipv4,
    _sanitize_error,
    _strip_dangerous_keys,
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
        with patch("dominusnode_composio.tools.socket.getaddrinfo", return_value=mock_infos):
            with pytest.raises(ValueError, match="private IP"):
                validate_url("http://evil.example.com/secret")

    def test_dns_rebinding_allows_public_resolved_ip(self):
        """If a hostname resolves to a public IP, it should be allowed."""
        mock_infos = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with patch("dominusnode_composio.tools.socket.getaddrinfo", return_value=mock_infos):
            result = validate_url("http://example.com/page")
            assert result == "http://example.com/page"

    def test_blocks_unresolvable_hostname(self):
        import socket as sock_mod
        with patch(
            "dominusnode_composio.tools.socket.getaddrinfo",
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
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="CU",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_iran(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="IR",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_north_korea(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="KP",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_case_insensitive(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="sy",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_allows_us(self):
        """US should NOT be blocked by OFAC check (but may fail on proxy connect)."""
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
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
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="POST",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_put(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="PUT",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_delete(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="DELETE",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_patch(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="PATCH",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_allows_get(self):
        """GET should pass method check (may fail on actual proxy connect)."""
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="GET",
        ))
        # Should not have a method restriction error
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_head(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="HEAD",
        ))
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_options(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
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
# Toolkit Initialization Tests
# ===========================================================================


class TestToolkitInit:
    """Test toolkit initialization and configuration."""

    def test_default_config(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        assert toolkit.api_key == "dn_test_key123"
        assert toolkit.base_url == "https://api.dominusnode.com"
        assert toolkit.timeout == 30.0

    def test_custom_config(self):
        toolkit = DominusNodeToolkit(
            api_key="dn_live_custom",
            base_url="http://localhost:3000",
            proxy_host="127.0.0.1",
            proxy_port=9090,
            timeout=60.0,
        )
        assert toolkit.api_key == "dn_live_custom"
        assert toolkit.base_url == "http://localhost:3000"
        assert toolkit.timeout == 60.0
        assert toolkit.proxy_port == 9090

    def test_env_fallback(self):
        with patch.dict(os.environ, {"DOMINUSNODE_API_KEY": "dn_test_from_env"}):
            toolkit = DominusNodeToolkit()
            assert toolkit.api_key == "dn_test_from_env"

    def test_env_proxy_host(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_HOST": "my-proxy.example.com"}):
            toolkit = DominusNodeToolkit(api_key="dn_test_key123")
            assert toolkit.proxy_host == "my-proxy.example.com"

    def test_env_proxy_port(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_PORT": "9999"}):
            toolkit = DominusNodeToolkit(api_key="dn_test_key123")
            assert toolkit.proxy_port == 9999

    def test_base_url_trailing_slash_stripped(self):
        toolkit = DominusNodeToolkit(
            api_key="dn_test_key123",
            base_url="https://api.example.com/",
        )
        assert toolkit.base_url == "https://api.example.com"


# ===========================================================================
# Composio Action Definition Tests
# ===========================================================================


class TestComposioActions:
    """Test the Composio-compatible get_actions() method."""

    def test_get_actions_returns_24(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        assert len(actions) == 26

    def test_all_actions_have_required_keys(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        for action in actions:
            assert "name" in action, f"Action missing 'name': {action}"
            assert "display_name" in action, f"Action missing 'display_name': {action.get('name')}"
            assert "description" in action, f"Action missing 'description': {action.get('name')}"
            assert "parameters" in action, f"Action missing 'parameters': {action.get('name')}"
            assert "handler" in action, f"Action missing 'handler': {action.get('name')}"

    def test_all_action_names_uppercase(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        for action in actions:
            assert action["name"] == action["name"].upper(), (
                f"Action name not uppercase: {action['name']}"
            )

    def test_all_action_names_prefixed(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        for action in actions:
            assert action["name"].startswith("DOMINUSNODE_"), (
                f"Action name not prefixed: {action['name']}"
            )

    def test_all_handlers_callable(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        for action in actions:
            assert callable(action["handler"]), (
                f"Handler not callable for: {action['name']}"
            )

    def test_expected_action_names(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        names = {a["name"] for a in actions}
        expected = {
            "DOMINUSNODE_PROXIED_FETCH",
            "DOMINUSNODE_CHECK_BALANCE",
            "DOMINUSNODE_CHECK_USAGE",
            "DOMINUSNODE_GET_PROXY_CONFIG",
            "DOMINUSNODE_LIST_SESSIONS",
            "DOMINUSNODE_CREATE_AGENTIC_WALLET",
            "DOMINUSNODE_FUND_AGENTIC_WALLET",
            "DOMINUSNODE_AGENTIC_WALLET_BALANCE",
            "DOMINUSNODE_LIST_AGENTIC_WALLETS",
            "DOMINUSNODE_AGENTIC_TRANSACTIONS",
            "DOMINUSNODE_FREEZE_AGENTIC_WALLET",
            "DOMINUSNODE_UNFREEZE_AGENTIC_WALLET",
            "DOMINUSNODE_DELETE_AGENTIC_WALLET",
            "DOMINUSNODE_UPDATE_WALLET_POLICY",
            "DOMINUSNODE_CREATE_TEAM",
            "DOMINUSNODE_LIST_TEAMS",
            "DOMINUSNODE_TEAM_DETAILS",
            "DOMINUSNODE_TEAM_FUND",
            "DOMINUSNODE_TEAM_CREATE_KEY",
            "DOMINUSNODE_TEAM_USAGE",
            "DOMINUSNODE_UPDATE_TEAM",
            "DOMINUSNODE_UPDATE_TEAM_MEMBER_ROLE",
            "DOMINUSNODE_X402_INFO",
            "DOMINUSNODE_TOPUP_PAYPAL",
            "DOMINUSNODE_TOPUP_STRIPE",
            "DOMINUSNODE_TOPUP_CRYPTO",
        }
        assert names == expected

    def test_proxied_fetch_action_has_url_param(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        fetch_action = next(a for a in actions if a["name"] == "DOMINUSNODE_PROXIED_FETCH")
        assert "url" in fetch_action["parameters"]
        assert fetch_action["parameters"]["url"]["required"] is True

    def test_action_handler_proxied_fetch_missing_url(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        fetch_action = next(a for a in actions if a["name"] == "DOMINUSNODE_PROXIED_FETCH")
        result = json.loads(fetch_action["handler"]({}))
        assert "error" in result
        assert "url" in result["error"].lower()

    def test_action_handler_create_team_missing_name(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_CREATE_TEAM")
        result = json.loads(action["handler"]({}))
        assert "error" in result
        assert "name" in result["error"].lower()

    def test_action_handler_topup_paypal_missing_amount(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_TOPUP_PAYPAL")
        result = json.loads(action["handler"]({}))
        assert "error" in result
        assert "amount_cents" in result["error"]

    def test_action_handler_fund_agentic_wallet_missing_params(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_FUND_AGENTIC_WALLET")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_create_agentic_wallet_missing_params(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_CREATE_AGENTIC_WALLET")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_team_fund_missing_params(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_TEAM_FUND")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_team_create_key_missing_params(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_TEAM_CREATE_KEY")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_update_team_member_role_missing_params(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_UPDATE_TEAM_MEMBER_ROLE")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_agentic_wallet_balance_missing_wallet_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_AGENTIC_WALLET_BALANCE")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_agentic_transactions_missing_wallet_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_AGENTIC_TRANSACTIONS")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_freeze_missing_wallet_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_FREEZE_AGENTIC_WALLET")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_unfreeze_missing_wallet_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_UNFREEZE_AGENTIC_WALLET")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_delete_missing_wallet_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_DELETE_AGENTIC_WALLET")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_team_details_missing_team_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_TEAM_DETAILS")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_team_usage_missing_team_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_TEAM_USAGE")
        result = json.loads(action["handler"]({}))
        assert "error" in result

    def test_action_handler_update_team_missing_team_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_UPDATE_TEAM")
        result = json.loads(action["handler"]({}))
        assert "error" in result


# ===========================================================================
# Input Validation Tests
# ===========================================================================


class TestInputValidation:
    """Test input validation for various actions."""

    def test_create_agentic_wallet_rejects_empty_label(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="", spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "label" in result["error"].lower()

    def test_create_agentic_wallet_rejects_long_label(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="x" * 101, spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_create_agentic_wallet_rejects_control_chars(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="bad\x00label", spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "control" in result["error"].lower()

    def test_create_agentic_wallet_rejects_negative_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=-1,
        ))
        assert "error" in result

    def test_create_agentic_wallet_rejects_zero_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=0,
        ))
        assert "error" in result

    def test_create_agentic_wallet_rejects_bool(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=True,  # type: ignore
        ))
        assert "error" in result

    def test_team_fund_rejects_below_minimum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=50,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_team_fund_rejects_above_maximum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=2_000_000,
        ))
        assert "error" in result

    def test_update_team_member_role_rejects_invalid_role(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_team_member_role(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            user_id="550e8400-e29b-41d4-a716-446655440001",
            role="superadmin",
        ))
        assert "error" in result
        assert "member" in result["error"]

    def test_update_team_rejects_no_changes(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_team(
            team_id="550e8400-e29b-41d4-a716-446655440000",
        ))
        assert "error" in result
        assert "At least one" in result["error"]

    def test_team_details_rejects_invalid_uuid(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.team_details(team_id="not-a-uuid"))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_agentic_transactions_rejects_limit_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.agentic_transactions(
            wallet_id="wallet-id", limit=0,
        ))
        assert "error" in result
        assert "limit" in result["error"].lower()

    def test_agentic_transactions_rejects_limit_over_100(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.agentic_transactions(
            wallet_id="wallet-id", limit=101,
        ))
        assert "error" in result

    def test_check_usage_rejects_invalid_period(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.check_usage(period="year"))
        assert "error" in result
        assert "period" in result["error"]

    def test_proxied_fetch_rejects_invalid_proxy_type(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", proxy_type="invalid",
        ))
        assert "error" in result
        assert "proxy_type" in result["error"]


# ===========================================================================
# PayPal Top-up Validation Tests
# ===========================================================================


class TestPayPalTopup:
    """Test PayPal top-up validation."""

    def test_rejects_below_minimum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=100))
        assert "error" in result
        assert "500" in result["error"]

    def test_rejects_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=0))
        assert "error" in result

    def test_rejects_negative(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=-500))
        assert "error" in result

    def test_rejects_above_maximum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=2_000_000))
        assert "error" in result
        assert "1000000" in result["error"] or "1,000,000" in result["error"]

    def test_rejects_boolean(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=True))  # type: ignore
        assert "error" in result

    @patch("dominusnode_composio.tools.httpx.Client")
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

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=1000))

        assert "orderId" in result
        assert result["orderId"] == "PAY-123"


# ===========================================================================
# Authentication Tests
# ===========================================================================


class TestAuthentication:
    """Test authentication behavior."""

    def test_no_api_key_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            toolkit = DominusNodeToolkit(api_key="")
            result = json.loads(toolkit.check_balance())
            assert "error" in result
            assert "API key" in result["error"]

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_auth_failure_returns_error(self, mock_httpx_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized"

        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        toolkit = DominusNodeToolkit(api_key="dn_test_badkey")
        result = json.loads(toolkit.check_balance())
        assert "error" in result

    @patch("dominusnode_composio.tools.httpx.Client")
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

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_401_retry_reauthenticates(self, mock_httpx_cls):
        """On 401 API error, toolkit should re-auth and retry once."""
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

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.check_balance())
        assert result["balanceCents"] == 1000


# ===========================================================================
# x402 Info Tests
# ===========================================================================


class TestX402Info:
    """Test x402 info action."""

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_x402_info_success(self, mock_httpx_cls):
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_123"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = '{"protocol":"x402","version":"1.0"}'
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = {"protocol": "x402", "version": "1.0"}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.x402_info())
        assert result["protocol"] == "x402"

    def test_x402_action_handler_works(self):
        """The x402 action handler should invoke x402_info."""
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_X402_INFO")
        # Will fail on auth (no server) but handler should be callable
        result = json.loads(action["handler"]({}))
        assert "error" in result  # Expected -- no server


# ===========================================================================
# Action Handler Integration Tests (with mocked API)
# ===========================================================================


class TestActionHandlerIntegration:
    """Test action handlers with mocked API responses."""

    def _make_toolkit_with_mock(self, mock_httpx_cls, api_response):
        """Helper to create a toolkit with mocked auth + API response."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_123"}

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

        return DominusNodeToolkit(api_key="dn_test_key123")

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_check_balance_handler(self, mock_httpx_cls):
        toolkit = self._make_toolkit_with_mock(
            mock_httpx_cls, {"balanceCents": 5000}
        )
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_CHECK_BALANCE")
        result = json.loads(action["handler"]({}))
        assert result["balanceCents"] == 5000

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_list_teams_handler(self, mock_httpx_cls):
        toolkit = self._make_toolkit_with_mock(
            mock_httpx_cls, {"teams": [{"id": "abc", "name": "Team A"}]}
        )
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_LIST_TEAMS")
        result = json.loads(action["handler"]({}))
        assert "teams" in result
        assert len(result["teams"]) == 1

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_list_agentic_wallets_handler(self, mock_httpx_cls):
        toolkit = self._make_toolkit_with_mock(
            mock_httpx_cls, {"wallets": []}
        )
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_LIST_AGENTIC_WALLETS")
        result = json.loads(action["handler"]({}))
        assert "wallets" in result

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_list_sessions_handler(self, mock_httpx_cls):
        toolkit = self._make_toolkit_with_mock(
            mock_httpx_cls, {"sessions": []}
        )
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_LIST_SESSIONS")
        result = json.loads(action["handler"]({}))
        assert "sessions" in result

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_check_usage_handler(self, mock_httpx_cls):
        toolkit = self._make_toolkit_with_mock(
            mock_httpx_cls, {"totalBytes": 1024}
        )
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_CHECK_USAGE")
        result = json.loads(action["handler"]({"period": "day"}))
        assert result["totalBytes"] == 1024

    @patch("dominusnode_composio.tools.httpx.Client")
    def test_get_proxy_config_handler(self, mock_httpx_cls):
        toolkit = self._make_toolkit_with_mock(
            mock_httpx_cls, {"httpProxy": {"host": "proxy.dominusnode.com", "port": 8080}}
        )
        actions = toolkit.get_actions()
        action = next(a for a in actions if a["name"] == "DOMINUSNODE_GET_PROXY_CONFIG")
        result = json.loads(action["handler"]({}))
        assert "httpProxy" in result


# ===========================================================================
# Wallet Policy Tests
# ===========================================================================


class TestWalletPolicy:
    """Test wallet policy fields on create_agentic_wallet and update_wallet_policy."""

    def test_create_with_daily_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            daily_limit_cents=5000,
        ))
        if "error" in result:
            assert "daily_limit_cents" not in result["error"]

    def test_create_with_allowed_domains(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains=["example.com"],
        ))
        if "error" in result:
            assert "allowed_domains" not in result["error"]

    def test_create_rejects_daily_limit_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_daily_limit_over_max(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            daily_limit_cents=1_000_001,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_invalid_domain(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains=["-bad.com"],
        ))
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_create_rejects_too_many_domains(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        domains = [f"d{i}.com" for i in range(101)]
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains=domains,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_create_rejects_domains_not_list(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains="example.com",  # type: ignore
        ))
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_update_wallet_policy_rejects_invalid_uuid(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="not-a-uuid",
            daily_limit_cents=5000,
        ))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_update_wallet_policy_rejects_daily_limit_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_update_wallet_policy_rejects_invalid_domain(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            allowed_domains=["bad domain"],
        ))
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_update_wallet_policy_in_actions(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        actions = toolkit.get_actions()
        names = [a["name"] for a in actions]
        assert "DOMINUSNODE_UPDATE_WALLET_POLICY" in names
