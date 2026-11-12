"""Core v2 tool-set tests: dispatch to the (mocked) SDK, scrubbing, key hygiene."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from dominusnode_agent_zero._core import NODE_SETUP_GUIDE, TOOL_NAMES, TOOL_SPECS, DominusNodeTools

KEY = "dn_live_" + "ab" * 32
STANDARD = [
    "fetch", "proxy_url", "network_policy", "network_pricing", "network_stats", "balance", "transactions",
    "topup_crypto", "check_payment", "usage", "active_sessions", "report_session", "node_list", "node_tier",
    "node_setup_guide", "credits_balance", "credits_convert", "payouts_list", "x402_info",
]
INV = "123e4567-e89b-12d3-a456-426614174000"

# tool -> (args, sdk method path, expected positional args, expected kwargs)
CASES = {
    "network_policy": ({}, "network.policy", (), {}),
    "network_pricing": ({}, "network.pricing", (), {}),
    "network_stats": ({}, "network.stats", (), {}),
    "balance": ({}, "wallet.get_balance", (), {}),
    "transactions": ({"limit": 5}, "wallet.get_transactions", (), {"limit": 5, "offset": None}),
    "topup_crypto": ({"amount_cents": 2000, "currency": "usdc"}, "wallet.top_up_crypto", (2000, "usdc"), {}),
    "check_payment": ({"invoice_id": INV}, "wallet.get_crypto_status", (INV,), {}),
    "usage": ({"from": "2026-01-01"}, "usage.get", (), {"from_": "2026-01-01", "to": None}),
    "active_sessions": ({}, "sessions.get_active", (), {}),
    "report_session": ({"session_id": INV, "reason": "captcha"}, "sessions.report", (INV, "captcha"), {}),
    "node_list": ({"limit": 3, "offset": 1}, "nodes.list", (), {"limit": 3, "offset": 1}),
    "node_tier": ({}, "nodes.tier", (), {}),
    "credits_balance": ({}, "credits.balance", (), {}),
    "credits_convert": ({"amount_musd": "50000"}, "credits.convert", ("50000",), {}),
    "payouts_list": ({}, "payouts.list", (), {"limit": None, "offset": None}),
    "x402_info": ({}, "x402.get_info", (), {}),
}


def _method(client: MagicMock, path: str) -> MagicMock:
    obj = client
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


@pytest.fixture()
def client() -> MagicMock:
    return MagicMock()


@pytest.fixture()
def tools(client: MagicMock) -> DominusNodeTools:
    return DominusNodeTools(api_key=KEY, client=client)


def test_core_has_exactly_the_19_standard_tools() -> None:
    assert TOOL_NAMES == STANDARD
    assert len(set(TOOL_NAMES)) == 19


def test_no_schema_mentions_api_key() -> None:
    for spec in TOOL_SPECS:
        props = {p.lower() for p in spec["parameters"]["properties"]}
        assert not props & {"api_key", "apikey", "key", "token", "password"}
    blob = json.dumps(TOOL_SPECS).lower()
    assert "dn_live_" not in blob
    assert "stripe" not in blob and "paypal" not in blob


@pytest.mark.parametrize("name", sorted(CASES))
def test_tool_calls_sdk_method(tools: DominusNodeTools, client: MagicMock, name: str) -> None:
    args, path, pos, kw = CASES[name]
    m = _method(client, path)
    m.return_value = {"ok": True, "tool": name}
    out = json.loads(tools.call(name, args))
    assert out == {"ok": True, "tool": name}
    m.assert_called_once_with(*pos, **kw)


def test_fetch_uses_sdk_proxy_fetch(tools: DominusNodeTools, client: MagicMock) -> None:
    resp = MagicMock(status=200, status_text="OK", headers={"content-type": "text/html"}, truncated=False)
    resp.text.return_value = "hello"
    client.proxy.fetch.return_value = resp
    out = json.loads(tools.call("dominusnode_fetch", {"url": "https://example.com", "country": "US", "ip_class": "dc"}))
    assert out["status"] == 200 and out["body"] == "hello"
    client.proxy.fetch.assert_called_once_with("https://example.com", method="GET", country="US", ip_class="dc",
                                               session_id=None, allow_http=False)


def test_proxy_url_hides_key(tools: DominusNodeTools, client: MagicMock) -> None:
    client.proxy.build_url.return_value = f"http://country-US:{KEY}@proxy.dominusnode.com:8080"
    raw = tools.call("proxy_url", {"country": "US"})
    assert KEY not in raw
    out = json.loads(raw)
    assert out["proxyUrl"] == "http://country-US:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8080"
    client.proxy.build_url.assert_called_once()


def test_node_setup_guide_is_static(tools: DominusNodeTools, client: MagicMock) -> None:
    out = json.loads(tools.call("node_setup_guide"))
    assert out["guide"] == NODE_SETUP_GUIDE and "node agent" in NODE_SETUP_GUIDE.lower()
    assert not client.method_calls


def test_errors_are_scrubbed(tools: DominusNodeTools, client: MagicMock) -> None:
    client.wallet.get_balance.side_effect = RuntimeError(f"boom {KEY} dn_test_{'c' * 64} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc")
    raw = tools.call("balance")
    assert "dn_live_" not in raw and "dn_test_" not in raw and "eyJ" not in raw
    assert "error" in json.loads(raw)


def test_outputs_are_scrubbed(tools: DominusNodeTools, client: MagicMock) -> None:
    client.network.stats.return_value = {"echo": KEY}
    assert KEY not in tools.call("network_stats")


def test_unknown_tool_and_args_rejected(tools: DominusNodeTools) -> None:
    assert "error" in json.loads(tools.call("create_stripe_checkout"))
    assert "error" in json.loads(tools.call("balance", {"api_key": KEY}))


def test_key_from_env_and_lazy_connect(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOMINUSNODE_API_KEY", KEY)
    t = DominusNodeTools()
    fake = MagicMock()
    fake.network.pricing.return_value = {"dc": "1"}
    t._client = fake  # injected SDK client, not yet connected
    t.call("network_pricing")
    fake.connect_with_key.assert_called_once_with(KEY)
    assert KEY not in repr(t)


def test_missing_key_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DOMINUSNODE_API_KEY", raising=False)
    out = json.loads(DominusNodeTools().call("balance"))
    assert "DOMINUSNODE_API_KEY" in out["error"]
