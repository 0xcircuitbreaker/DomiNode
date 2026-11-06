"""LlamaIndex registration: exactly the 19 v2 tools, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from llama_index.core.tools import FunctionTool

from dominusnode_llamaindex import TOOL_NAMES, DominusNodeToolSpec

KEY = "dn_live_" + "a1b2c3d4" * 4


def _spec():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodeToolSpec(api_key=KEY, client=sdk), sdk


def test_registration_matches_standard_set():
    spec, _ = _spec()
    tools = spec.to_tool_list()
    assert [t.metadata.name for t in tools] == list(TOOL_NAMES)
    assert all(isinstance(t, FunctionTool) for t in tools)


def test_schemas_have_no_key():
    spec, _ = _spec()
    for t in spec.to_tool_list():
        schema = json.dumps(t.metadata.get_parameters_dict())
        assert KEY not in schema and "api_key" not in schema and "self" not in json.loads(schema)["properties"]
        assert KEY not in t.metadata.description
    assert KEY not in repr(spec)


def test_call_routes_to_sdk():
    spec, sdk = _spec()
    sdk.credits.balance.return_value = {"available": {"musd": "42"}}
    tool = {t.metadata.name: t for t in spec.to_tool_list()}["dominusnode_credits_balance"]
    out = tool.call()
    sdk.credits.balance.assert_called_once()
    assert "42" in str(out)


def test_call_with_args_and_scrubbed_error():
    spec, sdk = _spec()
    sdk.nodes.list.side_effect = RuntimeError("bad " + KEY)
    tool = {t.metadata.name: t for t in spec.to_tool_list()}["dominusnode_node_list"]
    out = str(tool.call(limit=3))
    sdk.nodes.list.assert_called_once_with(limit=3, offset=0)
    assert out.startswith("Error:") and KEY not in out
