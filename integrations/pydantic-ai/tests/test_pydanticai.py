"""Pydantic AI adapter: registration and dispatch through a real Agent run (TestModel)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from pydantic_ai import Agent, FunctionToolset, Tool
from pydantic_ai.models.test import TestModel

from dominusnode_pydanticai import TOOL_NAMES, DominusNodeToolkit

FAKE_KEY = "dn_live_" + "k" * 40


def _tk():
    sdk = MagicMock()
    return DominusNodeToolkit(api_key=FAKE_KEY, client=sdk), sdk


def test_registers_exactly_19_tools():
    tk, _ = _tk()
    tools = tk.tools()
    assert all(isinstance(t, Tool) for t in tools)
    assert [t.name for t in tools] == ["dominusnode_" + n for n in TOOL_NAMES]
    ts = tk.toolset()
    assert isinstance(ts, FunctionToolset)
    assert sorted(ts.tools) == sorted("dominusnode_" + n for n in TOOL_NAMES)


def test_agent_sees_19_tools_without_key():
    tk, _ = _tk()
    model = TestModel(call_tools=[])
    Agent(model, toolsets=[tk.toolset()]).run_sync("hi")
    params = model.last_model_request_parameters
    names = sorted(t.name for t in params.function_tools)
    assert names == sorted("dominusnode_" + n for n in TOOL_NAMES)
    text = json.dumps([t.parameters_json_schema for t in params.function_tools])
    assert FAKE_KEY not in text and "api_key" not in text


def test_agent_tool_call_hits_sdk_and_is_scrubbed():
    tk, sdk = _tk()
    sdk.network.pricing.return_value = {"note": f"leak {FAKE_KEY}", "dc": "3000000"}
    model = TestModel(call_tools=["dominusnode_network_pricing"])
    result = Agent(model, toolsets=[tk.toolset()]).run_sync("prices?")
    sdk.network.pricing.assert_called_once()
    assert FAKE_KEY not in json.dumps(result.all_messages_json().decode())


def test_direct_tool_function_dispatch():
    tk, sdk = _tk()
    sdk.sessions.report.return_value = {"reportId": "r"}
    fn = {t.name: t for t in tk.tools()}["dominusnode_report_session"].function
    assert fn(session_id="123e4567-e89b-42d3-a456-426614174000", reason="slow") == {"reportId": "r"}
    sdk.sessions.report.assert_called_once()
