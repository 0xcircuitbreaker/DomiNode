"""Langflow adapter: real langchain_core StructuredTool registration and dispatch."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from langchain_core.tools import StructuredTool

from dominusnode_langflow import TOOL_NAMES, DominusNodeToolkit

FAKE_KEY = "dn_live_" + "k" * 40


def _tk():
    sdk = MagicMock()
    return DominusNodeToolkit(api_key=FAKE_KEY, client=sdk), sdk


def _by_name(tk):
    return {t.name: t for t in tk.get_tools()}


def test_registers_exactly_19_tools():
    tk, _ = _tk()
    tools = tk.get_tools()
    assert all(isinstance(t, StructuredTool) for t in tools)
    assert [t.name for t in tools] == ["dominusnode_" + n for n in TOOL_NAMES]


def test_invoke_dispatches_to_sdk():
    tk, sdk = _tk()
    sdk.credits.balance.return_value = {"available": "50000"}
    out = json.loads(_by_name(tk)["dominusnode_credits_balance"].invoke({}))
    assert out["available"] == "50000"
    sdk.credits.balance.assert_called_once_with()
    out = json.loads(_by_name(tk)["dominusnode_credits_convert"].invoke({"amount_musd": "50000"}))
    assert out["status"] == "signing_required"
    sdk.credits.convert.assert_not_called()


def test_fetch_tool_args():
    tk, sdk = _tk()
    res = MagicMock(status=200, status_text="OK", headers={}, truncated=False)
    res.text.return_value = "ok"
    sdk.proxy.fetch.return_value = res
    out = json.loads(_by_name(tk)["dominusnode_fetch"].invoke({"url": "https://example.com", "ip_class": "dc"}))
    assert out["body"] == "ok"
    assert sdk.proxy.fetch.call_args.kwargs["ip_class"] == "dc"


def test_schemas_have_no_key():
    tk, _ = _tk()
    for t in tk.get_tools():
        assert "api_key" not in t.args
        assert FAKE_KEY not in json.dumps(t.args)


def test_langflow_component_builds_19_tools(monkeypatch):
    """langflow itself is too heavy to install here; stub its base classes."""
    import importlib
    import sys
    import types

    custom = types.ModuleType("langflow.custom")
    io = types.ModuleType("langflow.io")
    custom.Component = type("Component", (), {})
    io.Output = lambda **kw: kw
    io.SecretStrInput = lambda **kw: kw
    monkeypatch.setitem(sys.modules, "langflow", types.ModuleType("langflow"))
    monkeypatch.setitem(sys.modules, "langflow.custom", custom)
    monkeypatch.setitem(sys.modules, "langflow.io", io)
    monkeypatch.setenv("DOMINUSNODE_API_KEY", FAKE_KEY)
    monkeypatch.delitem(sys.modules, "dominusnode_langflow.component", raising=False)
    mod = importlib.import_module("dominusnode_langflow.component")
    comp = mod.DominusNodeToolsComponent()
    comp.api_key = ""
    tools = comp.build_tools()
    assert [t.name for t in tools] == ["dominusnode_" + n for n in TOOL_NAMES]


def test_error_scrubbed():
    tk, sdk = _tk()
    sdk.nodes.tier.side_effect = Exception(f"bad {FAKE_KEY}")
    out = _by_name(tk)["dominusnode_node_tier"].invoke({})
    assert FAKE_KEY not in out and "[REDACTED]" in out
