"""Core tool-set tests: each standard tool calls the right SDK method (SDK mocked)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from dominusnode_ironclaw._core import TOOL_NAMES, TOOL_SPECS, DominusNodeToolkit

FAKE_KEY = "dn_live_" + "k" * 40
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"
UUID = "123e4567-e89b-42d3-a456-426614174000"

STANDARD = {
    "fetch", "proxy_url", "network_policy", "network_pricing", "network_stats", "balance",
    "transactions", "topup_crypto", "check_payment", "usage", "active_sessions", "report_session",
    "node_list", "node_tier", "node_setup_guide", "credits_balance", "credits_convert",
    "payouts_list", "x402_info",
}

# tool -> (arguments, SDK method path, expected positional args, expected kwargs subset)
CASES = {
    "network_policy": ({}, "network.policy", (), {}),
    "network_pricing": ({}, "network.pricing", (), {}),
    "network_stats": ({}, "network.stats", (), {}),
    "balance": ({}, "wallet.get_balance", (), {}),
    "transactions": ({"limit": 5}, "wallet.get_transactions", (), {"limit": 5}),
    "topup_crypto": ({"amount_cents": 2000, "currency": "usdc"}, "wallet.top_up_crypto", (2000, "usdc"), {}),
    "check_payment": ({"invoice_id": UUID}, "wallet.get_crypto_status", (UUID,), {}),
    "usage": ({"since": "2026-01-01"}, "usage.get", (), {"from_": "2026-01-01"}),
    "active_sessions": ({}, "sessions.get_active", (), {}),
    "report_session": ({"session_id": UUID, "reason": "captcha"}, "sessions.report", (UUID, "captcha"), {}),
    "node_list": ({"limit": 3}, "nodes.list", (), {"limit": 3}),
    "node_tier": ({}, "nodes.tier", (), {}),
    "credits_balance": ({}, "credits.balance", (), {}),
    "credits_convert": ({"amount_musd": "50000"}, "credits.convert", ("50000",), {}),
    "payouts_list": ({"offset": 10}, "payouts.list", (), {"offset": 10}),
    "x402_info": ({}, "x402.get_info", (), {}),
}


def _attr(obj, path):
    for p in path.split("."):
        obj = getattr(obj, p)
    return obj


@pytest.fixture()
def sdk():
    c = MagicMock()
    c.proxy.build_url.return_value = f"http://country-US:{FAKE_KEY}@proxy.dominusnode.daedalusdevelopmentgroup.com:8080"
    c.proxy.build_username.return_value = "country-US"
    res = MagicMock(status=200, status_text="OK", headers={"content-type": "text/html"}, truncated=False)
    res.text.return_value = "hello world"
    c.proxy.fetch.return_value = res
    return c


@pytest.fixture()
def tk(sdk):
    return DominusNodeToolkit(api_key=FAKE_KEY, client=sdk)


def test_tool_names_are_the_standard_19():
    assert len(TOOL_NAMES) == 19
    assert set(TOOL_NAMES) == STANDARD
    assert set(TOOL_SPECS) == STANDARD


@pytest.mark.parametrize("name", sorted(CASES))
def test_tool_calls_sdk_method(tk, sdk, name):
    args, path, pos, kw = CASES[name]
    _attr(sdk, path).return_value = {"ok": True}
    out = tk.call(name, args)
    assert out == {"ok": True}
    method = _attr(sdk, path)
    method.assert_called_once()
    call = method.call_args
    assert tuple(call.args) == pos
    for k, v in kw.items():
        assert call.kwargs[k] == v
    sdk.connect_with_key.assert_called_once_with(FAKE_KEY)


def test_fetch_calls_proxy_fetch(tk, sdk):
    out = tk.fetch("https://example.com", country="US", ip_class="residential", max_chars=5)
    sdk.proxy.fetch.assert_called_once()
    assert sdk.proxy.fetch.call_args.args == ("https://example.com",)
    kw = sdk.proxy.fetch.call_args.kwargs
    assert kw["method"] == "GET" and kw["country"] == "US" and kw["ip_class"] == "residential"
    assert kw["allow_http"] is False
    assert out["status"] == 200 and out["body"] == "hello" and out["bodyTruncated"] is True


def test_proxy_url_masks_key(tk, sdk):
    out = tk.proxy_url(country="US")
    sdk.proxy.build_url.assert_called_once()
    sdk.proxy.build_username.assert_called_once()
    assert out["url"] == "http://country-US:<DOMINUSNODE_API_KEY>@proxy.dominusnode.daedalusdevelopmentgroup.com:8080"
    assert FAKE_KEY not in json.dumps(out)


def test_node_setup_guide_is_static(tk, sdk):
    out = tk.node_setup_guide()
    assert "steps" in out and "node agent" in json.dumps(out)
    sdk.connect_with_key.assert_not_called()


def test_errors_are_scrubbed(tk, sdk):
    sdk.network.policy.side_effect = RuntimeError(f"boom {FAKE_KEY} {JWT} dn_node_" + "a" * 64)
    out = tk.network_policy()
    assert "error" in out
    text = json.dumps(out)
    assert FAKE_KEY not in text and JWT not in text and "dn_node_" not in text
    assert "[REDACTED]" in text


def test_outputs_are_scrubbed(tk, sdk):
    sdk.wallet.get_balance.return_value = {"note": f"key {FAKE_KEY}", "nested": [{"t": JWT}]}
    text = json.dumps(tk.balance())
    assert FAKE_KEY not in text and JWT not in text


def test_missing_key_is_an_error(monkeypatch, sdk):
    monkeypatch.delenv("DOMINUSNODE_API_KEY", raising=False)
    out = DominusNodeToolkit(client=sdk).balance()
    assert "DOMINUSNODE_API_KEY" in out["error"]


def test_key_from_env(monkeypatch, sdk):
    monkeypatch.setenv("DOMINUSNODE_API_KEY", FAKE_KEY)
    sdk.wallet.get_balance.return_value = {"balanceCents": 100}
    tk = DominusNodeToolkit(client=sdk)
    assert tk.balance() == {"balanceCents": 100}
    sdk.connect_with_key.assert_called_once_with(FAKE_KEY)
    assert FAKE_KEY not in repr(tk)


def test_key_never_in_schemas():
    for spec in TOOL_SPECS.values():
        for prop in spec["parameters"]["properties"]:
            assert not any(w in prop.lower() for w in ("key", "token", "password", "secret")) or prop == "idempotency_key"
    assert "dn_live_" not in json.dumps(TOOL_SPECS)


def test_unknown_tool_and_argument(tk):
    assert "error" in tk.call("topup_paypal", {})
    assert "error" in tk.call("balance", {"api_key": FAKE_KEY})


def test_no_legacy_surface():
    text = json.dumps(TOOL_SPECS).lower()
    for word in ("stripe", "paypal", "plan", "slot", "$3", "$5", "dc-country", "residential-"):
        assert word not in text
