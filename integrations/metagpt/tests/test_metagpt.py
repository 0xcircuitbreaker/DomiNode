"""MetaGPT adapter. MetaGPT does not install on Python >= 3.12, so its registry is stubbed."""

from __future__ import annotations

import inspect
import json
import sys
import types
from unittest.mock import MagicMock

from dominusnode_metagpt import TOOL_NAMES, DominusNodeTools, register

FAKE_KEY = "dn_live_" + "k" * 40


def _tools():
    sdk = MagicMock()
    return DominusNodeTools(api_key=FAKE_KEY, client=sdk), sdk


def test_class_exposes_19_documented_methods():
    for name in TOOL_NAMES:
        fn = getattr(DominusNodeTools, name)
        assert inspect.getdoc(fn) and "Returns:" in inspect.getdoc(fn)
        assert "api_key" not in inspect.signature(fn).parameters
        assert FAKE_KEY not in inspect.getdoc(fn)


def test_register_passes_exact_tool_set(monkeypatch):
    calls = {}

    def register_tool(tags=None, include_functions=None, **kw):
        calls["tags"], calls["include"] = tags, include_functions
        return lambda cls: cls

    pkg = types.ModuleType("metagpt")
    tools_pkg = types.ModuleType("metagpt.tools")
    reg = types.ModuleType("metagpt.tools.tool_registry")
    reg.register_tool = register_tool
    monkeypatch.setitem(sys.modules, "metagpt", pkg)
    monkeypatch.setitem(sys.modules, "metagpt.tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "metagpt.tools.tool_registry", reg)
    assert register() is DominusNodeTools
    assert calls["include"] == TOOL_NAMES and len(calls["include"]) == 19
    assert "dominusnode" in calls["tags"]


def test_methods_return_json_and_call_sdk():
    t, sdk = _tools()
    sdk.usage.get.return_value = {"summary": {"totalBytes": 1}}
    assert json.loads(t.usage(since="2026-01-01")) == {"summary": {"totalBytes": 1}}
    sdk.usage.get.assert_called_once()


def test_errors_scrubbed():
    t, sdk = _tools()
    sdk.wallet.get_balance.side_effect = Exception(f"nope {FAKE_KEY}")
    out = t.balance()
    assert FAKE_KEY not in out and "[REDACTED]" in out
