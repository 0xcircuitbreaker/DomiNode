"""Haystack adapter: registration and dispatch through real haystack.tools.Tool objects."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from haystack.tools import Tool, Toolset

from dominusnode_haystack import TOOL_NAMES, DominusNodeToolkit

FAKE_KEY = "dn_live_" + "k" * 40


def _tk():
    sdk = MagicMock()
    return DominusNodeToolkit(api_key=FAKE_KEY, client=sdk), sdk


def _by_name(tk):
    return {t.name: t for t in tk.get_tools()}


def test_registers_exactly_19_tools():
    tk, _ = _tk()
    tools = tk.get_tools()
    assert all(isinstance(t, Tool) for t in tools)
    assert [t.name for t in tools] == ["dominusnode_" + n for n in TOOL_NAMES]
    assert len(tools) == 19
    ts = tk.get_toolset()
    assert isinstance(ts, Toolset) and len(list(ts)) == 19


def test_tool_invoke_dispatches_to_sdk():
    tk, sdk = _tk()
    sdk.wallet.top_up_crypto.return_value = {"invoiceId": "x"}
    out = json.loads(_by_name(tk)["dominusnode_topup_crypto"].invoke(amount_cents=1500, currency="btc"))
    assert out == {"invoiceId": "x"}
    sdk.wallet.top_up_crypto.assert_called_once_with(1500, "btc")


def test_fetch_tool_dispatches_to_proxy_fetch():
    tk, sdk = _tk()
    res = MagicMock(status=204, status_text="No Content", headers={}, truncated=False)
    res.text.return_value = ""
    sdk.proxy.fetch.return_value = res
    out = json.loads(_by_name(tk)["dominusnode_fetch"].invoke(url="https://example.com", method="HEAD"))
    assert out["status"] == 204
    assert sdk.proxy.fetch.call_args.kwargs["method"] == "HEAD"


def test_schemas_have_no_key():
    tk, _ = _tk()
    for t in tk.get_tools():
        text = json.dumps(t.tool_spec)
        assert FAKE_KEY not in text and "api_key" not in text


def test_error_output_scrubbed():
    tk, sdk = _tk()
    sdk.credits.balance.side_effect = Exception(f"denied for {FAKE_KEY}")
    out = _by_name(tk)["dominusnode_credits_balance"].invoke()
    assert FAKE_KEY not in out and "[REDACTED]" in out
