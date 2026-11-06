"""CAMEL registration: exactly the 19 v2 tools, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from camel.toolkits import BaseToolkit, FunctionTool

from dominusnode_camel import TOOL_NAMES, DominusNodeToolkit

KEY = "dn_live_" + "a1b2c3d4" * 4


def _toolkit():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodeToolkit(api_key=KEY, client=sdk), sdk


def test_registration_matches_standard_set():
    tk, _ = _toolkit()
    tools = tk.get_tools()
    assert isinstance(tk, BaseToolkit)
    assert all(isinstance(t, FunctionTool) for t in tools)
    assert [t.get_function_name() for t in tools] == list(TOOL_NAMES)


def test_schemas_have_no_key():
    tk, _ = _toolkit()
    for t in tk.get_tools():
        schema = t.get_openai_tool_schema()
        text = json.dumps(schema)
        assert KEY not in text and "api_key" not in text
        assert "self" not in schema["function"]["parameters"].get("properties", {})
        assert schema["function"]["description"]
    assert KEY not in repr(tk)


def test_call_routes_to_sdk():
    tk, sdk = _toolkit()
    sdk.sessions.get_active.return_value = {"sessions": []}
    tool = {t.get_function_name(): t for t in tk.get_tools()}["dominusnode_active_sessions"]
    out = tool()
    sdk.sessions.get_active.assert_called_once()
    assert "sessions" in out


def test_call_with_args_and_scrubbed_error():
    tk, sdk = _toolkit()
    sdk.wallet.get_transactions.side_effect = RuntimeError("bad " + KEY)
    tool = {t.get_function_name(): t for t in tk.get_tools()}["dominusnode_transactions"]
    out = tool(limit=7)
    sdk.wallet.get_transactions.assert_called_once_with(limit=7, offset=0)
    assert out.startswith("Error:") and KEY not in out
