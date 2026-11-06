"""Core v2 tool behaviour: SDK mapping, scrubbing and key handling (SDK mocked)."""

import json
from unittest.mock import MagicMock

import pytest

from dominusnode_composio._core import TOOL_NAMES, DominusNodeTools

KEY = "dn_live_" + "a1b2c3d4" * 4

EXPECTED = {
    "dominusnode_proxy_url": ({"country": "US", "ip_class": "dc"}, "proxy.build_username"),
    "dominusnode_network_policy": ({}, "network.policy"),
    "dominusnode_network_pricing": ({}, "network.pricing"),
    "dominusnode_network_stats": ({}, "network.stats"),
    "dominusnode_balance": ({}, "wallet.get_balance"),
    "dominusnode_transactions": ({"limit": 5}, "wallet.get_transactions"),
    "dominusnode_topup_crypto": ({"amount_cents": 1000, "currency": "usdc"}, "wallet.top_up_crypto"),
    "dominusnode_check_payment": ({"invoice_id": "11111111-1111-1111-1111-111111111111"}, "wallet.get_crypto_status"),
    "dominusnode_usage": ({"since": "2026-01-01"}, "usage.get"),
    "dominusnode_active_sessions": ({}, "sessions.get_active"),
    "dominusnode_report_session": (
        {"session_id": "11111111-1111-1111-1111-111111111111", "reason": "captcha"}, "sessions.report"),
    "dominusnode_node_list": ({}, "nodes.list"),
    "dominusnode_node_tier": ({}, "nodes.tier"),
    "dominusnode_credits_balance": ({}, "credits.balance"),
    "dominusnode_credits_convert": ({"amount_musd": "10000"}, "credits.convert"),
    "dominusnode_payouts_list": ({}, "payouts.list"),
    "dominusnode_x402_info": ({}, "x402.get_info"),
}


def _resolve(obj, path):
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


@pytest.fixture
def sdk():
    c = MagicMock()
    c.is_connected = False
    c.proxy.build_username.return_value = "country-US-class-dc"
    resp = MagicMock(status=200, status_text="OK", headers={"content-type": "text/html", "set-cookie": "x"},
                     truncated=False)
    resp.text.return_value = "hello world"
    c.proxy.fetch.return_value = resp
    return c


@pytest.fixture
def tools(sdk):
    return DominusNodeTools(api_key=KEY, client=sdk)


def test_nineteen_tools():
    assert len(TOOL_NAMES) == 19 == len(set(TOOL_NAMES))
    assert set(EXPECTED) | {"dominusnode_fetch", "dominusnode_node_setup_guide"} == set(TOOL_NAMES)


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_tool_calls_sdk(tools, sdk, name):
    kwargs, path = EXPECTED[name]
    _resolve(sdk, path).return_value = {"ok": True, "tool": name}
    out = getattr(tools, name)(**kwargs)
    assert _resolve(sdk, path).called, name
    assert not out.startswith("Error"), out
    sdk.connect_with_key.assert_called_once_with(KEY)


def test_argument_mapping(tools, sdk):
    tools.dominusnode_topup_crypto(amount_cents=2500, currency="btc")
    sdk.wallet.top_up_crypto.assert_called_once_with(2500, "btc")
    tools.dominusnode_usage(since="a", until="b")
    sdk.usage.get.assert_called_once_with(from_="a", to="b")
    tools.dominusnode_credits_convert(amount_musd="20000")
    sdk.credits.convert.assert_called_once_with("20000", idempotency_key=None)
    tools.dominusnode_report_session(session_id="s", reason="slow")
    sdk.sessions.report.assert_called_once_with("s", "slow")


def test_fetch(tools, sdk):
    out = json.loads(tools.dominusnode_fetch(url="https://example.com", country="DE", max_chars=5))
    sdk.proxy.fetch.assert_called_once_with(
        "https://example.com", method="GET", country="DE", ip_class=None, session_id=None, allow_http=False
    )
    assert out["status"] == 200 and out["body"] == "hello" and out["bodyTruncated"] is True
    assert "set-cookie" not in out["headers"]


def test_proxy_url_has_no_key(tools, sdk):
    out = tools.dominusnode_proxy_url(country="US", ip_class="dc")
    assert KEY not in out and "<DOMINUSNODE_API_KEY>" in out and "country-US-class-dc" in out
    sdk.proxy.build_url.assert_not_called()


def test_setup_guide_static(tools, sdk):
    out = tools.dominusnode_node_setup_guide()
    assert "node agent" in out
    sdk.connect_with_key.assert_not_called()


def test_errors_scrubbed(tools, sdk):
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123"
    sdk.wallet.get_balance.side_effect = RuntimeError(f"boom {KEY} and dn_node_{'f' * 32} {jwt}")
    out = tools.dominusnode_balance()
    assert out.startswith("Error:")
    assert KEY not in out and "dn_node_" + "f" * 32 not in out and jwt not in out


def test_outputs_scrubbed(tools, sdk):
    sdk.network.stats.return_value = {"leak": KEY}
    assert KEY not in tools.dominusnode_network_stats()


def test_missing_key(monkeypatch):
    monkeypatch.delenv("DOMINUSNODE_API_KEY", raising=False)
    sdk = MagicMock()
    sdk.is_connected = False
    out = DominusNodeTools(client=sdk).dominusnode_balance()
    assert out.startswith("Error:") and "DOMINUSNODE_API_KEY" in out


def test_key_from_env(monkeypatch, sdk):
    monkeypatch.setenv("DOMINUSNODE_API_KEY", KEY)
    DominusNodeTools(client=sdk).dominusnode_balance()
    sdk.connect_with_key.assert_called_once_with(KEY)


def test_repr_hides_key(tools):
    assert KEY not in repr(tools) and KEY not in str(tools)
